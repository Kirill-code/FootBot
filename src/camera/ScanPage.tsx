import { useEffect, useRef, useState } from 'react'
import { db, type FootSide } from '../profile/db'
import { loadOpenCv, subscribeOpenCvState, type OpenCvLoadState } from '../analysis/opencvLoader'
import type { FootContourPoint, FootMeasurement, FootView } from '../analysis/measureFoot'
import { buildFootModel, type FootModel } from '../analysis/footModel'

// Мастер сканирования: 3 ракурса (сверху / сбоку / спереди 45°) → модель стопы.
// OpenCV и модуль анализа грузятся динамически — в main-бандл не попадают.

type Phase =
  | 'idle' // шаг ожидает фото
  | 'loading-opencv' // загрузка wasm (~16 МБ)
  | 'analyzing' // анализ фото
  | 'no-reference' // стопа есть, эталона нет
  | 'no-foot' // стопа не найдена
  | 'engine-error'
  | 'done' // ракурс принят

const MAX_DIM_PX = 1600
const MAX_BLOB_BYTES = 1024 * 1024 // 1 МБ

interface StepInfo {
  view: FootView
  title: string
  hint: string
  noReferenceHint: string
  noFootHint: string
}

const STEPS: StepInfo[] = [
  {
    view: 'top',
    title: 'Фото 1/3 — стопа сверху',
    hint: 'Снимите стопу строго сверху. Рядом на полу положите лист А4 (или А5, или банковскую карту) — целиком в кадр.',
    noReferenceHint: 'Стопа найдена, но эталон масштаба не распознан. Положите рядом со стопой лист А4 или банковскую карту (целиком в кадр) и переснимите.',
    noFootHint: 'Стопа не найдена. Снимите строго сверху, вся стопа в кадре, на контрастном полу.'
  },
  {
    view: 'side',
    title: 'Фото 2/3 — стопа сбоку',
    hint: 'Снимите стопу сбоку: стопа стоит на полу, лист А4 или карта лежат на полу рядом (на той же линии пола).',
    noReferenceHint: 'Стопа найдена, но эталон не распознан. Положите лист А4 или карту на пол рядом со стопой и переснимите.',
    noFootHint: 'Стопа не найдена. Снимите сбоку, чтобы стопа целиком была в кадре и не сливалась с фоном.'
  },
  {
    view: 'front',
    title: 'Фото 3/3 — стопа спереди под 45°',
    hint: 'Снимите стопу спереди под углом ~45° (пальцы ближе к камере). Лист А4 или карта на полу рядом.',
    noReferenceHint: 'Стопа найдена, но эталон не распознан. Положите лист А4 или карту рядом со стопой и переснимите.',
    noFootHint: 'Стопа не найдена. Снимите спереди под 45°, вся стопа в кадре, на контрастном полу.'
  }
]

/** Читает файл в ImageData + canvas, уменьшая до maxDim px. */
async function fileToImageData(file: Blob, maxDim: number): Promise<{ imageData: ImageData; canvas: HTMLCanvasElement }> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { imageData: ctx.getImageData(0, 0, w, h), canvas }
}

/** Превью с наложенным контуром стопы. */
function PreviewImage({ url }: { url: string }) {
  return <img src={url} alt="Стопа с контуром" style={{ width: '100%', borderRadius: 10, display: 'block' }} />
}

function drawPreview(canvas: HTMLCanvasElement, contour: FootContourPoint[]): string {
  const preview = document.createElement('canvas')
  preview.width = canvas.width
  preview.height = canvas.height
  const ctx = preview.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  if (contour.length >= 3) {
    ctx.strokeStyle = '#3ddc84'
    ctx.lineWidth = Math.max(3, canvas.width / 250)
    ctx.beginPath()
    contour.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
    ctx.stroke()
  }
  return preview.toDataURL('image/jpeg', 0.85)
}

/** Сериализует canvas в Blob: webp q0.8, fallback jpeg; ≤ 1 МБ. */
async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const toBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

  let blob = await toBlob('image/webp', 0.8)
  if (blob && blob.size <= MAX_BLOB_BYTES) return blob

  for (const q of [0.8, 0.6, 0.4]) {
    blob = await toBlob('image/jpeg', q)
    if (blob && blob.size <= MAX_BLOB_BYTES) return blob
  }
  const last = await toBlob('image/jpeg', 0.4)
  if (!last) throw new Error('Не удалось сохранить фото')
  return last
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

/** Есть ли по ракурсу хоть одна метрика с эталоном. */
function viewMeasured(m: FootMeasurement | undefined, view: FootView): boolean {
  if (!m) return false
  if (view === 'top') return m.lengthMm !== null && m.widthMm !== null
  if (view === 'side') return m.instepHeightMm !== null
  return m.ballWidthMm !== null
}

export default function ScanPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [foot, setFoot] = useState<FootSide>('left')
  const [step, setStep] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [cvState, setCvState] = useState<OpenCvLoadState>('idle')
  const progress = useLoadingProgress(phase === 'loading-opencv', cvState === 'ready')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [errorText, setErrorText] = useState('')
  const [measures, setMeasures] = useState<Partial<Record<FootView, FootMeasurement>>>({})
  const [model, setModel] = useState<FootModel | null>(null)
  const [finished, setFinished] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({ lengthMm: '', widthMm: '', instepHeightMm: '', ballWidthMm: '' })
  const [manualSaved, setManualSaved] = useState(false)

  useEffect(() => subscribeOpenCvState(setCvState), [])

  const stepInfo = STEPS[step]
  const busy = phase === 'loading-opencv' || phase === 'analyzing'

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setPhase('loading-opencv')
    setPreviewUrl(null)
    setErrorText('')
    try {
      await loadOpenCv()
      const { imageData, canvas } = await fileToImageData(file, MAX_DIM_PX)

      setPhase('analyzing')
      const { measureFoot } = await import('../analysis/measureFoot')
      const m = measureFoot(imageData, { view: stepInfo.view })

      if (m.footFound && m.footContour.length >= 3) {
        setPreviewUrl(drawPreview(canvas, m.footContour))
      }

      if (!m.footFound) {
        setPhase('no-foot')
        return
      }
      if (!viewMeasured(m, stepInfo.view)) {
        setPhase('no-reference')
        return
      }

      // Ракурс принят: сохраняем фото (+ замер для top) и идём дальше.
      const blob = await canvasToBlob(canvas)
      await db.photos.add({
        foot,
        createdAt: Date.now(),
        blob,
        footLengthMm: m.lengthMm,
        footWidthMm: m.widthMm
      })
      if (stepInfo.view === 'top' && m.lengthMm !== null) {
        await db.measurements.add({
          createdAt: Date.now(),
          footLengthMm: m.lengthMm,
          footWidthMm: m.widthMm ?? m.lengthMm * 0.4,
          source: 'opencv',
          contour: m.footContour
        })
      }
      setMeasures((prev) => ({ ...prev, [stepInfo.view]: m }))
      setPhase('done')
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPhase('engine-error')
    }
  }

  function nextStep() {
    setPreviewUrl(null)
    setPhase('idle')
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      finish(measures)
    }
  }

  function finish(current: Partial<Record<FootView, FootMeasurement>>) {
    const m = buildFootModel(current)
    setModel(m)
    db.footModels.add({
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
    setFinished(true)
  }

  function skipStep() {
    const next = { ...measures }
    delete next[stepInfo.view]
    setMeasures(next)
    setPreviewUrl(null)
    setPhase('idle')
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      finish(next)
    }
  }

  async function handleManualSave() {
    const lengthMm = manual.lengthMm ? Number(manual.lengthMm) : null
    const widthMm = manual.widthMm ? Number(manual.widthMm) : null
    const instepHeightMm = manual.instepHeightMm ? Number(manual.instepHeightMm) : null
    const ballWidthMm = manual.ballWidthMm ? Number(manual.ballWidthMm) : null
    if ([lengthMm, widthMm, instepHeightMm, ballWidthMm].some((v) => v !== null && (!Number.isFinite(v) || v <= 0))) {
      setErrorText('Введите положительные числа в миллиметрах')
      return
    }
    if (lengthMm === null && model?.lengthMm == null) {
      setErrorText('Укажите хотя бы длину стопы')
      return
    }
    setErrorText('')
    const m = buildFootModel({
      top: lengthMm !== null && widthMm !== null ? ({ lengthMm, widthMm } as FootMeasurement) : null,
      side: instepHeightMm !== null && lengthMm !== null ? ({ lengthMm, instepHeightMm } as FootMeasurement) : null,
      front: ballWidthMm !== null ? ({ lengthMm: lengthMm ?? 0, ballWidthMm } as FootMeasurement) : null
    })
    const merged: FootModel = {
      ...m,
      lengthMm: m.lengthMm ?? model?.lengthMm ?? null,
      widthMm: m.widthMm ?? model?.widthMm ?? null,
      instepHeightMm: m.instepHeightMm ?? model?.instepHeightMm ?? null,
      ballWidthMm: m.ballWidthMm ?? model?.ballWidthMm ?? null
    }
    merged.widthRatio =
      merged.widthMm !== null && merged.lengthMm !== null && merged.lengthMm > 0
        ? Math.round((merged.widthMm / merged.lengthMm) * 100) / 100
        : null
    await db.footModels.add({
      foot,
      createdAt: Date.now(),
      lengthMm: merged.lengthMm,
      widthMm: merged.widthMm,
      instepHeightMm: merged.instepHeightMm,
      ballWidthMm: merged.ballWidthMm,
      widthRatio: merged.widthRatio,
      volumeHint: merged.volumeHint,
      inconsistent: merged.inconsistent,
      source: 'manual'
    })
    setModel(merged)
    setManualSaved(true)
  }

  const volumeText = { low: 'низкий объём', medium: 'средний объём', high: 'высокий объём' } as const

  if (finished && model) {
    return (
      <main className="page">
        <h1 className="page-title">Модель {foot === 'left' ? 'левой' : 'правой'} стопы</h1>
        <p className="page-subtitle">Собрано из {Object.keys(measures).length} из 3 ракурсов</p>

        <div className="card" style={{ display: 'grid', gap: 6 }}>
          {model.lengthMm !== null && <p className="hint">Длина: <strong>{model.lengthMm} мм</strong></p>}
          {model.widthMm !== null && <p className="hint">Ширина: <strong>{model.widthMm} мм</strong></p>}
          {model.instepHeightMm !== null && <p className="hint">Высота подъёма: <strong>{model.instepHeightMm} мм</strong></p>}
          {model.ballWidthMm !== null && <p className="hint">Ширина переднего отдела: <strong>{model.ballWidthMm} мм</strong></p>}
          {model.widthRatio !== null && <p className="hint">Отношение ширины к длине: <strong>{model.widthRatio}</strong></p>}
          {model.volumeHint !== null && <p className="hint">Объём: <strong>{volumeText[model.volumeHint]}</strong></p>}
          {model.inconsistent && (
            <p className="hint" style={{ color: '#ff7a7a' }}>
              Замеры ракурсов заметно различаются (более 15 мм) — рекомендуем переснять.
            </p>
          )}
          <p className="hint" style={{ color: 'var(--accent)' }}>Сохранено в профиль</p>
        </div>

        {!manualOpen ? (
          <button className="btn btn-secondary btn-block" onClick={() => { setManualOpen(true); setManualSaved(false); setErrorText('') }}>
            Дополнить вручную
          </button>
        ) : (
          <div className="card" style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>Ручной ввод (недостающие замеры)</p>
            {[
              ['lengthMm', 'Длина стопы, мм'],
              ['widthMm', 'Ширина стопы, мм'],
              ['instepHeightMm', 'Высота подъёма, мм'],
              ['ballWidthMm', 'Ширина переднего отдела, мм']
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

        <button className="btn btn-block" onClick={() => { setFinished(false); setStep(0); setPhase('idle'); setMeasures({}); setPreviewUrl(null) }}>
          Новое сканирование
        </button>
      </main>
    )
  }

  return (
    <main className="page">
      <h1 className="page-title">Скан стопы</h1>
      <p className="page-subtitle">Три ракурса — точная модель стопы</p>

      <div className="card" style={{ display: 'flex', gap: 8 }}>
        {STEPS.map((s, i) => (
          <div
            key={s.view}
            className="btn btn-secondary btn-block"
            style={{
              padding: '8px 4px',
              fontSize: 13,
              borderColor: i === step ? 'var(--accent)' : 'var(--border)',
              color: i === step ? 'var(--accent)' : i < step ? 'var(--accent)' : undefined,
              opacity: i <= step ? 1 : 0.5
            }}
          >
            {i < step ? '✓ ' : ''}{i + 1}
          </div>
        ))}
      </div>

      <div className="card">
        <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{stepInfo.title}</p>
        <p className="hint">{stepInfo.hint}</p>
      </div>

      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-secondary btn-block"
          style={foot === 'left' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => setFoot('left')}
          disabled={busy}
        >
          Левая
        </button>
        <button
          className="btn btn-secondary btn-block"
          style={foot === 'right' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => setFoot('right')}
          disabled={busy}
        >
          Правая
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handleFile}
      />

      {phase === 'done' ? (
        <>
          <button className="btn btn-block" onClick={nextStep}>
            {step < STEPS.length - 1 ? 'Далее' : 'Построить модель стопы'}
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => { setPhase('idle'); setPreviewUrl(null) }}>
            Переснять
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-block" disabled={busy} onClick={() => inputRef.current?.click()}>
            {phase === 'loading-opencv'
              ? 'Загружаем движок анализа…'
              : phase === 'analyzing'
                ? 'Анализ фото…'
                : 'Сфотографировать'}
          </button>
          {phase !== 'idle' && (
            <button className="btn btn-secondary btn-block" disabled={busy} onClick={skipStep}>
              Пропустить ракурс
            </button>
          )}
        </>
      )}

      {phase === 'loading-opencv' && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <p className="hint">
            Загружаем движок анализа (~16 МБ). Рекомендуем Wi-Fi — на мобильной сети
            загрузка может занять до минуты.
          </p>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent)', transition: 'width 0.5s ease' }} />
          </div>
          <p className="hint" style={{ textAlign: 'right' }}>{progress}%</p>
        </div>
      )}

      {previewUrl && <PreviewImage url={previewUrl} />}

      {phase === 'no-reference' && (
        <div className="card">
          <p className="hint" style={{ color: 'var(--accent)' }}>{stepInfo.noReferenceHint}</p>
        </div>
      )}

      {phase === 'no-foot' && (
        <div className="card">
          <p className="hint" style={{ color: '#ff7a7a' }}>{stepInfo.noFootHint}</p>
        </div>
      )}

      {phase === 'engine-error' && (
        <div className="card">
          <p className="hint" style={{ color: '#ff7a7a' }}>
            Не удалось загрузить или запустить движок анализа: {errorText}.
            Проверьте соединение (при первом запуске нужен интернет) и попробуйте снова.
          </p>
        </div>
      )}
    </main>
  )
}
