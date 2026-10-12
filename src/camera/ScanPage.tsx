import { useCallback, useEffect, useRef, useState } from 'react'
import { db, type FootSide } from '../profile/db'
import { loadOpenCv, subscribeOpenCvState, type OpenCvLoadState } from '../analysis/opencvLoader'
import type { FootContourPoint, FootMeasurement, FootView } from '../analysis/measureFoot'
import { buildFootModel, type FootModel } from '../analysis/footModel'
import CameraView, { type CameraShot } from './CameraView'

// Мастер сканирования: СНАЧАЛА сбор двух фото (сверху + сбоку), ПОТОМ анализ.
// Третий ракурс (45°) убран: модель стопы строится по длине/ширине/подъёму.
// OpenCV и модуль анализа грузятся динамически — в main-бандл не попадают.
// Съёмка — живой видоискатель CameraView (NN-подсказки в реальном времени),
// fallback — штатная камера / галерея.

type Phase =
  | 'collect' // сбор фото (шаг 1/2 или 2/2)
  | 'analyzing' // единый экран анализа
  | 'results' // результаты по ракурсам
  | 'saved' // модель сохранена

type StepState = 'idle' | 'preview' // внутри collect

interface StepInfo {
  view: FootView
  title: string
  why: string
  noReferenceHint: string
  noFootHint: string
}

const STEPS: StepInfo[] = [
  {
    view: 'top',
    title: 'Фото 1/2 — стопа сверху (+ карта рядом)',
    why: 'Сверху измеряем длину и ширину стопы. Положите рядом банковскую карту (или лист А4, если камера высоко) — по ней считаем масштаб. Снимайте босиком, без носков — носок искажает размер.',
    noReferenceHint: 'Стопа найдена, но эталон масштаба не распознан. Положите рядом со стопой банковскую карту (или лист А4) — целиком в кадр, в углу рамки — и переснимите.',
    noFootHint: 'Стопа не найдена. Снимите строго сверху, вся стопа в кадре, босиком (без носков), на контрастном полу.'
  },
  {
    view: 'side',
    title: 'Фото 2/2 — стопа сбоку',
    why: 'Сбоку измеряем высоту подъёма — она влияет на выбор модели кроссовок. Босиком, без носков.',
    noReferenceHint: '',
    noFootHint: 'Стопа не найдена. Снимите сбоку, чтобы стопа целиком была в кадре: видны и пятка, и носок, стопа стоит на полу. Босиком (без носков).'
  }
]

interface Shot {
  blob: Blob
  previewUrl: string
  imageData: ImageData
  canvas: HTMLCanvasElement
}

/** fileToImageData и canvasToBlob переехали в ./imageIO (общие с CameraView). */

/** Превью с наложенным контуром стопы. */
function drawPreview(canvas: HTMLCanvasElement, contour?: FootContourPoint[]): string {
  const preview = document.createElement('canvas')
  preview.width = canvas.width
  preview.height = canvas.height
  const ctx = preview.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  if (contour && contour.length >= 3) {
    ctx.strokeStyle = '#3ddc84'
    ctx.lineWidth = Math.max(3, canvas.width / 250)
    ctx.beginPath()
    contour.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
    ctx.stroke()
  }
  return preview.toDataURL('image/jpeg', 0.85)
}

/** Прогресс загрузки движка: реальные байты недоступны, показываем плавный ход. */
function useLoadingProgress(active: boolean, done: boolean): number {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (!active) {
      setProgress(0)
      return
    }
    if (done) {
      setProgress(100)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000
      const estimate = Math.min(95, (elapsed / 45) * 100)
      setProgress((p) => Math.max(p, Math.round(estimate)))
    }, 500)
    return () => clearInterval(timer)
  }, [active, done])
  return progress
}

/** Есть ли по ракурсу целевая метрика. */
function viewMeasured(m: FootMeasurement | undefined, view: FootView): boolean {
  if (!m) return false
  return view === 'top' ? m.lengthMm !== null && m.widthMm !== null : m.instepRatio !== null || m.instepHeightMm !== null
}

/** Человекочитаемая причина неудачи ракурса. */
function failureHint(m: FootMeasurement | undefined, step: StepInfo): string | null {
  if (!m || !m.footFound) return step.noFootHint
  if (!viewMeasured(m, step.view)) return step.noReferenceHint || 'Не удалось измерить подъём — переснимите ракурс.'
  return null
}

export default function ScanPage() {
  const [foot, setFoot] = useState<FootSide>('left')
  const [step, setStep] = useState(0)
  const [phase, setPhase] = useState<Phase>('collect')
  const [stepState, setStepState] = useState<StepState>('idle')
  const [cvState, setCvState] = useState<OpenCvLoadState>('idle')
  const engineProgress = useLoadingProgress(phase === 'analyzing' && cvState !== 'ready', cvState === 'ready')
  const [analyzingView, setAnalyzingView] = useState<string>('')
  const [sockWarn, setSockWarn] = useState(false)
  const [shots, setShots] = useState<Partial<Record<FootView, Shot>>>({})
  const [analysis, setAnalysis] = useState<Partial<Record<FootView, FootMeasurement>>>({})
  const [previews, setPreviews] = useState<Partial<Record<FootView, string>>>({})
  const [errorText, setErrorText] = useState('')
  const [model, setModel] = useState<FootModel | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({ lengthMm: '', widthMm: '', instepHeightMm: '' })
  const [manualSaved, setManualSaved] = useState(false)

  useEffect(() => subscribeOpenCvState(setCvState), [])

  const stepInfo = STEPS[step]

  /** Кадр с CameraView (или его fallback-галереи) уходит в общий пайплайн. */
  const handleCapture = useCallback((shot: CameraShot) => {
    setErrorText('')
    try {
      const previewUrl = drawPreview(shot.canvas)
      setShots((prev) => ({
        ...prev,
        [stepInfoRef.current.view]: { blob: shot.blob, previewUrl, imageData: shot.imageData, canvas: shot.canvas }
      }))
      setStepState('preview')
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Автоопределение стопы из CameraView применяем к выбранной стороне. */
  const handleFootGuess = useCallback((side: FootSide) => setFoot(side), [])

  const stepInfoRef = useRef(stepInfo)
  stepInfoRef.current = stepInfo

  async function analyze() {
    setPhase('analyzing')
    setErrorText('')
    setSockWarn(false)
    try {
      // 1. Движок (лениво, singleton) — один раз на оба ракурса.
      await loadOpenCv()
      const { measureFoot } = await import('../analysis/measureFoot')
      // 1б. Модель NN-сегментации (~17 МБ, один раз). Не критична —
      // при недоступности работает классический анализ.
      let nnOk = false
      try {
        setAnalyzingView('Загружаем модель сегментации (~17 МБ, один раз)…')
        const { loadPersonSegmenter } = await import('../analysis/personSegment')
        await loadPersonSegmenter()
        nnOk = true
      } catch {
        /* классика как fallback */
      }
      const results: Partial<Record<FootView, FootMeasurement>> = {}
      const pv: Partial<Record<FootView, string>> = {}
      let sock = false
      // 2. Анализ top.
      if (shots.top) {
        setAnalyzingView('Фото 1/2 — стопа сверху…')
        const personMask = nnOk ? await (await import('../analysis/personSegment')).getPersonMask(shots.top.imageData) : null
        const m = measureFoot(shots.top.imageData, { view: 'top', personMask })
        sock = sock || m.sockDetected
        results.top = m
        pv.top = drawPreview(shots.top.canvas, m.footContour)
      }
      // 3. Анализ side.
      if (shots.side) {
        setAnalyzingView('Фото 2/2 — стопа сбоку…')
        const personMask = nnOk ? await (await import('../analysis/personSegment')).getPersonMask(shots.side.imageData) : null
        const m = measureFoot(shots.side.imageData, { view: 'side', personMask })
        sock = sock || m.sockDetected
        results.side = m
        pv.side = drawPreview(shots.side.canvas, m.footContour)
      }
      setSockWarn(sock)
      setAnalysis(results)
      setPreviews(pv)
      setPhase('results')
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPhase('collect')
    }
  }

  function retake(view: FootView) {
    const idx = STEPS.findIndex((s) => s.view === view)
    setStep(idx)
    setShots((prev) => {
      const next = { ...prev }
      delete next[view]
      return next
    })
    setStepState('idle')
    setPhase('collect')
  }

  async function saveModel() {
    const m = buildFootModel(analysis)
    setModel(m)
    await db.transaction('rw', db.photos, db.measurements, db.footModels, async () => {
      if (shots.top) {
        await db.photos.add({ foot, createdAt: Date.now(), blob: shots.top.blob, footLengthMm: m.lengthMm, footWidthMm: m.widthMm })
      }
      if (shots.side) {
        await db.photos.add({ foot, createdAt: Date.now(), blob: shots.side.blob, footLengthMm: m.lengthMm, footWidthMm: null })
      }
      if (m.lengthMm !== null) {
        await db.measurements.add({
          createdAt: Date.now(),
          footLengthMm: m.lengthMm,
          footWidthMm: m.widthMm ?? m.lengthMm * 0.4,
          source: 'opencv',
          contour: analysis.top?.footContour
        })
      }
      await db.footModels.add({
        foot,
        createdAt: Date.now(),
        lengthMm: m.lengthMm,
        widthMm: m.widthMm,
        instepHeightMm: m.instepHeightMm,
        ballWidthMm: m.ballWidthMm,
        widthRatio: m.widthRatio,
        volumeHint: m.volumeHint,
        inconsistent: m.inconsistent,
        source: 'opencv'
      })
    })
    setPhase('saved')
  }

  async function handleManualSave() {
    const lengthMm = manual.lengthMm ? Number(manual.lengthMm) : null
    const widthMm = manual.widthMm ? Number(manual.widthMm) : null
    const instepHeightMm = manual.instepHeightMm ? Number(manual.instepHeightMm) : null
    if ([lengthMm, widthMm, instepHeightMm].some((v) => v !== null && (!Number.isFinite(v) || v <= 0))) {
      setErrorText('Введите положительные числа в миллиметрах')
      return
    }
    if (lengthMm === null) {
      setErrorText('Укажите хотя бы длину стопы')
      return
    }
    setErrorText('')
    const m = buildFootModel({
      top: widthMm !== null ? ({ view: 'top', lengthMm, widthMm } as FootMeasurement) : null,
      side: instepHeightMm !== null ? ({ view: 'side', lengthMm, instepHeightMm } as FootMeasurement) : null
    })
    await db.footModels.add({
      foot,
      createdAt: Date.now(),
      lengthMm: m.lengthMm,
      widthMm: m.widthMm,
      instepHeightMm: m.instepHeightMm,
      ballWidthMm: null,
      widthRatio: m.widthRatio,
      volumeHint: m.volumeHint,
      inconsistent: m.inconsistent,
      source: 'manual'
    })
    setModel(m)
    setManualSaved(true)
    setPhase('saved')
  }

  const volumeText = { low: 'низкий объём', medium: 'средний объём', high: 'высокий объём' } as const

  if (phase === 'saved' && model) {
    return (
      <main className="page">
        <h1 className="page-title">Модель {foot === 'left' ? 'левой' : 'правой'} стопы</h1>
        <p className="page-subtitle">Сохранено в профиль</p>
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          {model.lengthMm !== null && <p className="hint">Длина: <strong>{model.lengthMm} мм</strong></p>}
          {model.widthMm !== null && <p className="hint">Ширина: <strong>{model.widthMm} мм</strong></p>}
          {model.instepHeightMm !== null && <p className="hint">Высота подъёма: <strong>{model.instepHeightMm} мм</strong></p>}
          {model.widthRatio !== null && <p className="hint">Отношение ширины к длине: <strong>{model.widthRatio}</strong></p>}
          {model.volumeHint !== null && <p className="hint">Объём: <strong>{volumeText[model.volumeHint]}</strong></p>}
          {model.inconsistent && (
            <p className="hint" style={{ color: '#ff7a7a' }}>Замеры ракурсов заметно различаются — рекомендуем переснять.</p>
          )}
        </div>
        <button className="btn btn-block" onClick={() => { setPhase('collect'); setStep(0); setStepState('idle'); setShots({}); setAnalysis({}); setPreviews({}); setModel(null) }}>
          Новое сканирование
        </button>
      </main>
    )
  }

  if (phase === 'analyzing') {
    return (
      <main className="page">
        <h1 className="page-title">Анализ фото</h1>
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          {cvState !== 'ready' ? (
            <>
              <p className="hint">
                Загружаем движок анализа (~16 МБ). Рекомендуем Wi-Fi — на мобильной сети
                загрузка может занять до минуты.
              </p>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--bg)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${engineProgress}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
              </div>
              <p className="hint" style={{ textAlign: 'right' }}>{engineProgress}%</p>
            </>
          ) : (
            <p className="hint">{analyzingView || 'Подготовка…'}</p>
          )}
        </div>
      </main>
    )
  }

  if (phase === 'results') {
    const anyMeasured = viewMeasured(analysis.top, 'top') || viewMeasured(analysis.side, 'side')
    return (
      <main className="page">
        <h1 className="page-title">Результат анализа</h1>
        <p className="page-subtitle">Проверьте, что нашлось на каждом фото</p>

        {(['top', 'side'] as FootView[]).map((view, i) => {
          const m = analysis[view]
          const fail = failureHint(m, STEPS[i])
          return (
            <div key={view} className="card" style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0, fontWeight: 600 }}>{STEPS[i].title}</p>
              {previews[view] && <img src={previews[view]} alt={STEPS[i].title} style={{ width: '100%', borderRadius: 10 }} />}
              {!fail && m ? (
                <p className="hint" style={{ color: 'var(--accent)' }}>
                  {view === 'top'
                    ? <>Длина <strong>{m.lengthMm} мм</strong> · Ширина <strong>{m.widthMm} мм</strong></>
                    : m.instepHeightMm !== null
                      ? <>Высота подъёма <strong>{m.instepHeightMm} мм</strong>{m.lengthMm !== null && <> · Длина (кросс-проверка) {m.lengthMm} мм</>}</>
                      : <>Подъём: <strong>{Math.round((m.instepRatio ?? 0) * 100)}% длины стопы</strong> (мм посчитаем после объединения с фото сверху)</>}
                </p>
              ) : (
                <p className="hint" style={{ color: 'var(--accent)' }}>{fail}</p>
              )}
              <button className="btn btn-secondary btn-block" onClick={() => retake(view)}>
                Переснять этот ракурс
              </button>
            </div>
          )
        })}

        {(analysis.top?.sockDetected || analysis.side?.sockDetected) && (
          <div className="card">
            <p className="hint" style={{ color: '#e8c547' }}>
              Похоже, на стопе носок — для точного подбора кроссовок снимите носки
              и переснимите.
            </p>
          </div>
        )}

        {errorText && (
          <div className="card">
            <p className="hint" style={{ color: '#ff7a7a' }}>Ошибка движка анализа: {errorText}</p>
          </div>
        )}

        {sockWarn && (
          <div className="card">
            <p className="hint" style={{ color: '#e8c547' }}>
              Похоже, на стопе носок — для точного подбора снимите носки и
              переснимите ракурс сверху.
            </p>
          </div>
        )}

        {anyMeasured && (
          <button className="btn btn-block" onClick={saveModel}>Сохранить модель стопы</button>
        )}
        <button className="btn btn-secondary btn-block" onClick={() => { setPhase('collect'); setStep(1); setStepState(shots.side ? 'preview' : 'idle') }}>
          Назад к фото
        </button>
        {!manualOpen ? (
          <button className="btn btn-secondary btn-block" onClick={() => { setManualOpen(true); setManualSaved(false); setErrorText('') }}>
            Ввести размеры вручную
          </button>
        ) : (
          <div className="card" style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>Ручной ввод</p>
            {[
              ['lengthMm', 'Длина стопы, мм'],
              ['widthMm', 'Ширина стопы, мм'],
              ['instepHeightMm', 'Высота подъёма, мм']
            ].map(([key, label]) => (
              <label key={key} className="hint">
                {label}
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  value={manual[key as keyof typeof manual]}
                  onChange={(e) => setManual({ ...manual, [key]: e.target.value })}
                  placeholder="оставьте пустым, если не знаете"
                />
              </label>
            ))}
            {errorText && <p className="hint" style={{ color: '#ff7a7a' }}>{errorText}</p>}
            <button className="btn btn-block" disabled={manualSaved} onClick={handleManualSave}>
              {manualSaved ? 'Сохранено в профиль' : 'Сохранить замер'}
            </button>
          </div>
        )}
      </main>
    )
  }

  // phase === 'collect'
  return (
    <main className="page">
      <h1 className="page-title">Скан стопы</h1>
      <p className="page-subtitle">Два фото, затем анализ</p>

      <div className="card" style={{ display: 'flex', gap: 8 }}>
        {STEPS.map((s, i) => (
          <div
            key={s.view}
            className="btn btn-secondary btn-block"
            style={{
              padding: '8px 4px',
              fontSize: 13,
              borderColor: i === step ? 'var(--accent)' : 'var(--border)',
              color: i === step ? 'var(--accent)' : shots[s.view] ? 'var(--accent)' : undefined,
              opacity: i <= step || shots[s.view] ? 1 : 0.5
            }}
          >
            {shots[s.view] ? '✓ ' : ''}{i + 1}
          </div>
        ))}
      </div>

      <div className="card">
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{stepInfo.title}</p>
        <p className="hint">{stepInfo.why}</p>
        <p className="hint" style={{ marginTop: 6, color: 'var(--accent)' }}>
          ⚠️ Ступни должны быть босиком, без носков — носок добавляет миллиметры и искажает подбор размера.
        </p>
        {stepInfo.view === 'top' && (
          <p className="hint" style={{ marginTop: 6 }}>
            Рядом со стопой положите банковскую карту в углу рамки (или лист А4,
            если камера высоко) — целиком в кадр, на одном полу со стопой.
            Снимайте при хорошем свете.
          </p>
        )}
        {stepInfo.view === 'side' && (
          <p className="hint" style={{ marginTop: 6 }}>
            Лист не нужен — только стопа сбоку на фоне пола. Камера на уровне пола,
            видны и пятка, и носок.
          </p>
        )}
      </div>

      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-secondary btn-block"
          style={foot === 'left' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => setFoot('left')}
        >
          Левая
        </button>
        <button
          className="btn btn-secondary btn-block"
          style={foot === 'right' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => setFoot('right')}
        >
          Правая
        </button>
      </div>

      {stepState === 'preview' && shots[stepInfo.view] ? (
        <>
          <div className="card" style={{ padding: 8 }}>
            <img src={shots[stepInfo.view]!.previewUrl} alt={stepInfo.title} style={{ width: '100%', borderRadius: 10 }} />
          </div>
          <button className="btn btn-block" onClick={() => setStepState('idle')}>
            Переснять
          </button>
          {step === 0 ? (
            <>
              <button className="btn btn-block" onClick={() => { setStep(1); setStepState(shots.side ? 'preview' : 'idle') }}>
                Далее
              </button>
              <button className="btn btn-secondary btn-block" disabled={!shots.side} onClick={analyze}>
                Перейти к анализу
              </button>
            </>
          ) : (
            <button className="btn btn-block" onClick={analyze}>
              Анализировать
            </button>
          )}
          {step === 1 && (
            <button className="btn btn-secondary btn-block" onClick={() => { setStep(0); setStepState(shots.top ? 'preview' : 'idle') }}>
              Назад
            </button>
          )}
        </>
      ) : (
        <>
          <CameraView
            view={stepInfo.view}
            foot={foot}
            onFootGuess={handleFootGuess}
            onCapture={handleCapture}
            active={phase === 'collect'}
          />
          {step === 1 && (
            <>
              <button className="btn btn-secondary btn-block" disabled={!shots.top || !shots.side} onClick={analyze}>
                Анализировать
              </button>
              <button className="btn btn-secondary btn-block" onClick={() => { setStep(0); setStepState(shots.top ? 'preview' : 'idle') }}>
                Назад
              </button>
            </>
          )}
        </>
      )}

      {errorText && (
        <div className="card">
          <p className="hint" style={{ color: '#ff7a7a' }}>{errorText}</p>
        </div>
      )}
    </main>
  )
}
