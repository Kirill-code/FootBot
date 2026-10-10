import { useEffect, useRef, useState } from 'react'
import { db, type FootSide } from '../profile/db'
import { loadOpenCv, subscribeOpenCvState, type OpenCvLoadState } from '../analysis/opencvLoader'

// Скан стопы: фото → downscale → OpenCV (лениво) → измерение с калибровкой А4.
// OpenCV и модуль анализа грузятся динамически — в main-бандл не попадают.

type Phase =
  | 'idle' // готов к выбору фото
  | 'loading-opencv' // загрузка wasm
  | 'analyzing' // анализ фото
  | 'saved' // результат сохранён
  | 'no-a4' // лист А4 не найден
  | 'error' // ошибка
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

const OPENCV_STATUS_TEXT: Record<OpenCvLoadState, string> = {
  idle: 'Подготовка…',
  loading: 'Загрузка OpenCV (первый запуск может занять время)…',
  ready: 'OpenCV загружен',
  error: 'Ошибка загрузки OpenCV'
}

export default function ScanPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [foot, setFoot] = useState<FootSide>('left')
  const [phase, setPhase] = useState<Phase>('idle')
  const [cvState, setCvState] = useState<OpenCvLoadState>('idle')
  const [result, setResult] = useState<{ lengthMm: number; widthMm: number } | null>(null)
  const [errorText, setErrorText] = useState('')
  const [manualLength, setManualLength] = useState('')
  const [manualWidth, setManualWidth] = useState('')
  const [manualSaved, setManualSaved] = useState(false)

  useEffect(() => subscribeOpenCvState(setCvState), [])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setPhase('loading-opencv')
    setResult(null)
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

      if (!m) {
        setPhase('no-a4')
        return
      }

      // 4. Сохраняем фото (≤1 МБ) + замер в Dexie, атомарно.
      const blob = await canvasToBlob(canvas)
      await db.transaction('rw', db.photos, db.measurements, async () => {
        await db.photos.add({
          foot,
          createdAt: Date.now(),
          blob,
          footLengthMm: m.lengthMm,
          footWidthMm: m.widthMm
        })
        await db.measurements.add({
          createdAt: Date.now(),
          footLengthMm: m.lengthMm,
          footWidthMm: m.widthMm,
          source: 'opencv',
          contour: m.contour
        })
      })
      setResult({ lengthMm: m.lengthMm, widthMm: m.widthMm })
      setPhase('saved')
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPhase('error')
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
      <p className="page-subtitle">Фото со стопой и листом А4 — автоматический замер</p>

      <div className="card">
        <p className="hint">
          Как снимать: положите стопу на тёмный лист или ковёр рядом с листом А4
          (можно ступить на него носком в угол). Снимайте строго сверху, чтобы весь
          лист А4 попал в кадр — он задаёт масштаб для измерений.
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
          ? OPENCV_STATUS_TEXT[cvState]
          : phase === 'analyzing'
            ? 'Анализ фото…'
            : `Сфотографировать ${foot === 'left' ? 'левую' : 'правую'} стопу`}
      </button>

      {phase === 'no-a4' && (
        <div className="card">
          <p className="hint" style={{ color: 'var(--accent)' }}>
            На фото не найден лист А4 — без него невозможно определить масштаб.
            Убедитесь, что весь лист попал в кадр и снимок сделан сверху, затем
            попробуйте ещё раз.
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div className="card">
          <p className="hint" style={{ color: '#ff7a7a' }}>
            Произошла ошибка: {errorText}
          </p>
        </div>
      )}

      {phase === 'saved' && result && (
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
