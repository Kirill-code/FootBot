// Финальный слепок ракурса: сохранённое фото + жёлтая маска контура стопы
// (как live-оверлей: заливка rgba(232,197,71,0.25) + контур #e8c547 2.5px).
// Контур в координатах анализ-кадра; фото (blob превью) того же размера —
// canvas оверлея работает в тех же пикселях, CSS растягивает оба слоя.

import { useEffect, useRef } from 'react'
import type { FootContourPoint } from '../analysis/measureFoot'

interface ResultSnapshotProps {
  /** object/data URL фото (чистое превью кадра). */
  url: string
  /** Контур стопы из FootMeasurement.footContour, или null. */
  contour?: FootContourPoint[] | null
  /** false — ракурс не распознан: подпись поверх фото, без маски. */
  recognized: boolean
}

export default function ResultSnapshot({ url, contour, recognized }: ResultSnapshotProps) {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas) return
    const draw = () => {
      if (!img.naturalWidth) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (contour && contour.length >= 3) {
        ctx.beginPath()
        contour.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fillStyle = 'rgba(232, 197, 71, 0.25)'
        ctx.fill()
        ctx.strokeStyle = '#e8c547'
        ctx.lineWidth = 2.5
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
    }
    if (img.complete && img.naturalWidth) draw()
    else img.onload = draw
  }, [url, contour])

  return (
    <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden' }}>
      <img ref={imgRef} src={url} alt="Снимок стопы" style={{ width: '100%', display: 'block' }} />
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      {!recognized && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0, 0, 0, 0.45)',
            color: '#e8c547',
            fontWeight: 600,
            fontSize: 15
          }}
        >
          Не распознано
        </div>
      )}
    </div>
  )
}
