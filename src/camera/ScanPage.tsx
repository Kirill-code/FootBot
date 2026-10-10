import { useEffect, useRef, useState } from 'react'
import { db, type FootSide } from '../profile/db'
import { loadOpenCv, subscribeOpenCvState, type OpenCvLoadState } from '../analysis/opencvLoader'

// Скан стопы: фото → downscale → OpenCV (лениво) → измерение с калибровкой
// по эталону (лист А4/А5 или банковская карта).
// OpenCV и модуль анализа грузятся динамически — в main-бандл не попадают.

type Phase =
  | 'idle' // готов к выбору фото
  | 'loading-opencv' // загрузка wasm (~16 МБ)
  | 'analyzing' // анализ фото
  | 'measured' // есть замер, сохранено
  | 'no-reference' // стопа найдена, эталон не найден
  | 'no-foot' // стопа не найдена
  | 'engine-error' // ошибка загрузки/работы движка
  | 'manual' // ручной ввод

const MAX_DIM_PX = 1600
const MAX_BLOB_BYTES = 1024 * 1024 // 1 МБ

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

/** Рисует превью фото с наложенным контуром стопы. */
function drawPreview(canvas: HTMLCanvasElement, contour: Array<{ x: number; y: number }>) {
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
      // 16 МБ: на медленном мобильном — до 60 с. Ползём до 95%, не «зависая».
      const elapsed = (Date.now() - started) / 1000
      const estimate = Math.min(95, (elapsed / 45) * 100)
      setProgress((p) => Math.max(p, Math.round(estimate)))
    }, 500)
    return () => clearInterval(timer)
  }, [active, done])
  return progress
}

export default function ScanPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [foot, setFoot] = useState<FootSide>('left')
  const [phase, setPhase] = useState<Phase>('idle')
  const [cvState, setCvState] = useState<OpenCvLoadState>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ lengthMm: number; widthMm: number } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [errorText, setErrorText] = useState('')
  const [manualLength, setManualLength] = useState('')
  const [manualWidth, setManualWidth] = useState('')
  const [manualSaved, setManualSaved] = useState(false)

  useEffect(() => subscribeOpenCvState(setCvState), [])
  const engineReady = cvState === 'ready'
  const loadingProgress = useLoadingProgress(phase === 'loading-opencv', engineReady)

  useEffect(() => {
    setProgress(loadingProgress)
  }, [loadingProgress])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setPhase('loading-opencv')
    setResult(null)
    setPreviewUrl(null)
    setErrorText('')
    try {
      // 1. Загружаем OpenCV (лениво, singleton).
      await loadOpenCv()

      // 2. Downscale фото.
      const { imageData, canvas } = await fileToImageData(file, MAX_DIM_PX)

      // 3. Анализ — модуль тоже ленивый.
      setPhase('analyzing')
      const { measureFoot } = await import('../analysis/measureFoot')
      const m = measureFoot(imageData)

      // Превью с контуром (если стопа найдена).
      if (m.footFound && m.footContour.length >= 3) {
        setPreviewUrl(drawPreview(canvas, m.footContour))
      }

      if (m.referenceFound && m.lengthMm !== null && m.widthMm !== null) {
        // 4а. Есть и эталон, и стопа — сохраняем фото + замер.
        const lengthMm = m.lengthMm
        const widthMm = m.widthMm
        const blob = await canvasToBlob(canvas)
        await db.transaction('rw', db.photos, db.measurements, async () => {
          await db.photos.add({
            foot,
            createdAt: Date.now(),
            blob,
            footLengthMm: lengthMm,
            footWidthMm: widthMm
          })
          await db.measurements.add({
            createdAt: Date.now(),
            footLengthMm: lengthMm,
            footWidthMm: widthMm,
            source: 'opencv',
            contour: m.footContour
          })
        })
        setResult({ lengthMm, widthMm })
        setPhase('measured')
      } else if (m.footFound) {
        // 4б. Стопа есть, эталона нет — фото сохраняем, просим переснять с эталоном.
        const blob = await canvasToBlob(canvas)
        await db.photos.add({
          foot,
          createdAt: Date.now(),
          blob,
          footLengthMm: null,
          footWidthMm: null
        })
        setPhase('no-reference')
      } else {
        setPhase('no-foot')
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPhase('engine-error')
    }
  }

  async function handleManualSave() {
    const lengthMm = Number(manualLength)
    const widthMm = Number(manualWidth)
    if (!Number.isFinite(lengthMm) || !Number.isFinite(widthMm) || lengthMm <= 0 || widthMm <= 0) {
      setErrorText('Введите длину и ширину в миллиметрах')
      return
    }
    setErrorText('')
    await db.measurements.add({
      createdAt: Date.now(),
      footLengthMm: Math.round(lengthMm * 10) / 10,
      footWidthMm: Math.round(widthMm * 10) / 10,
      source: 'manual'
    })
    setManualSaved(true)
  }

  const busy = phase === 'loading-opencv' || phase === 'analyzing'

  return (
    <main className="page">
      <h1 className="page-title">Скан стопы</h1>
      <p className="page-subtitle">Фото стопы рядом с известным объектом — автоматический замер</p>

      <div className="card">
        <p className="hint">
          Как снимать: положите стопу на пол и рядом положите банковскую карту или лист А4/А5
          (весь объект должен попасть в кадр). Снимайте строго сверху. Карта или лист задают
          масштаб для измерений.
        </p>
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

      <button className="btn btn-block" disabled={busy} onClick={() => inputRef.current?.click()}>
        {phase === 'loading-opencv'
          ? 'Загружаем движок анализа…'
          : phase === 'analyzing'
            ? 'Анализ фото…'
            : `Сфотографировать ${foot === 'left' ? 'левую' : 'правую'} стопу`}
      </button>

      {phase === 'loading-opencv' && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <p className="hint">
            Загружаем движок анализа (~16 МБ). Рекомендуем Wi-Fi — на мобильной сети
            загрузка может занять до минуты.
          </p>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: 'var(--accent)',
                transition: 'width 0.5s ease'
              }}
            />
          </div>
          <p className="hint" style={{ textAlign: 'right' }}>{progress}%</p>
        </div>
      )}

      {previewUrl && (
        <div className="card" style={{ padding: 8 }}>
          <img src={previewUrl} alt="Стопа с контуром" style={{ width: '100%', borderRadius: 10 }} />
        </div>
      )}

      {phase === 'measured' && result && (
        <div className="card">
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>Результат измерения</p>
          <p className="hint">
            Длина: <strong>{result.lengthMm} мм</strong> · Ширина: <strong>{result.widthMm} мм</strong>
          </p>
          <p className="hint" style={{ color: 'var(--accent)', marginTop: 8 }}>
            Сохранено в профиль
          </p>
        </div>
      )}

      {phase === 'no-reference' && (
        <div className="card">
          <p className="hint" style={{ color: 'var(--accent)' }}>
            Стопа найдена (контур на фото), но не найден эталон масштаба. Положите рядом со
            стопой банковскую карту или лист А4 и переснимите — тогда приложение само
            измерит стопу. Либо введите размеры вручную ниже.
          </p>
        </div>
      )}

      {phase === 'no-foot' && (
        <div className="card">
          <p className="hint" style={{ color: '#ff7a7a' }}>
            Стопа не найдена на фото. Снимите строго сверху, чтобы вся стопа попала в кадр,
            на контрастном полу (носок не должен сливаться с фоном), и попробуйте ещё раз.
          </p>
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

      {phase !== 'manual' ? (
        <button className="btn btn-secondary btn-block" disabled={busy} onClick={() => { setPhase('manual'); setManualSaved(false); setManualLength(''); setManualWidth(''); setErrorText('') }}>
          Ввести размеры вручную
        </button>
      ) : (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Ручной ввод замера</p>
          <label className="hint">
            Длина стопы, мм
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={50}
              max={400}
              value={manualLength}
              onChange={(e) => setManualLength(e.target.value)}
              placeholder="например, 265"
            />
          </label>
          <label className="hint">
            Ширина стопы, мм
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={50}
              max={300}
              value={manualWidth}
              onChange={(e) => setManualWidth(e.target.value)}
              placeholder="например, 100"
            />
          </label>
          {errorText && <p className="hint" style={{ color: '#ff7a7a' }}>{errorText}</p>}
          <button className="btn btn-block" disabled={manualSaved} onClick={handleManualSave}>
            {manualSaved ? 'Сохранено в профиль' : 'Сохранить замер'}
          </button>
        </div>
      )}
    </main>
  )
}
