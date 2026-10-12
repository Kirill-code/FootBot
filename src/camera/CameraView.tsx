// Живой камерный видоискатель с NN-сканированием в реальном времени.
// Каждые ~350 мс кадр с видео (даунскейл до 640px) сегментируется
// selfie_multiclass (person-классы), контур силуэта рисуется поверх видео,
// рамка гайда меняет цвет по статусу позиционирования. OpenCV здесь НЕ
// используется — только при финальном анализе в ScanPage.
// Fallback: недоступный/запрещённый getUserMedia → старый input capture.

import { useEffect, useRef, useState } from 'react'
import type { FootView } from '../analysis/measureFoot'
import type { FootSide } from '../profile/db'
import {
  getPersonMask,
  loadPersonSegmenter,
  subscribePersonSegmentState,
  type PersonSegmentState
} from '../analysis/personSegment'
import { detectLaterality } from '../analysis/footLaterality'
import { maskToContour, personBinFromCategories } from './liveContour'
import { canvasToBlob, fileToImageData } from './imageIO'

const ANALYSIS_DIM = 640 // длинная сторона кадра для сегментации
const CAPTURE_DIM = 1600
const LOOP_MS = 350
const MIN_FOOT_FRACTION = 0.004 // <0.4% кадра — стопа не найдена

export interface CameraShot {
  blob: Blob
  imageData: ImageData
  canvas: HTMLCanvasElement
}

interface CameraViewProps {
  view: FootView
  onCapture: (shot: CameraShot) => void
  /** Текущая выбранная стопа (для подтверждения автоопределения). */
  foot?: FootSide
  /** Применить автоопределённую сторону стопы. */
  onFootGuess?: (side: FootSide) => void
}

type CameraState = 'starting' | 'live' | 'denied'
type FrameStatus = 'loading' | 'error' | 'none' | 'partial' | 'far' | 'ok'

const STATUS_COLOR: Record<FrameStatus, string> = {
  loading: '#8a8a8a',
  error: '#8a8a8a',
  none: '#f87171',
  partial: '#e8c547',
  far: '#e8c547',
  ok: '#4ade80'
}

const STATUS_TEXT: Record<FrameStatus, string> = {
  loading: 'Загрузка модели сегментации…',
  error: 'Модель недоступна — снимайте по подсказкам',
  none: 'Стопа не найдена — придвиньте стопу в кадр',
  partial: 'Отодвиньте — вся стопа не влезает в кадр',
  far: 'Придвиньте стопу к рамке',
  ok: 'Стопа в кадре ✓'
}

interface GuideRect {
  x: number
  y: number
  w: number
  h: number
}

/** Рамка гайда: 70% ширины, 60% высоты, по центру (в долях кадра). */
function guideRect(mw: number, mh: number): GuideRect {
  const w = mw * 0.7
  const h = mh * 0.6
  return { x: (mw - w) / 2, y: (mh - h) / 2, w, h }
}

function contourBBox(pts: { x: number; y: number }[]) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

export default function CameraView({ view, onCapture, foot, onFootGuess }: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const busyRef = useRef(false)
  const [cameraState, setCameraState] = useState<CameraState>('starting')
  const [videoAspect, setVideoAspect] = useState(4 / 3)
  const [camError, setCamError] = useState('')
  const [nnState, setNnState] = useState<PersonSegmentState>('idle')
  const [status, setStatus] = useState<FrameStatus>('loading')
  const [laterality, setLaterality] = useState<{ side: FootSide; confidence: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  // Запуск камеры.
  useEffect(() => {
    let cancelled = false
    const stream = navigator.mediaDevices?.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    })
    if (!stream) {
      setCameraState('denied')
      return
    }
    stream
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = s
        const v = videoRef.current
        if (v) {
          v.srcObject = s
          v.onloadedmetadata = () => {
            // Аспект контейнера = аспект потока, иначе objectFit cover
            // кадрирует кадр и оверлей разъедется.
            if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight)
          }
          v.play().catch(() => setCameraState('denied'))
        }
        setCameraState('live')
      })
      .catch((e: unknown) => {
        setCamError(e instanceof Error ? e.message : String(e))
        setCameraState('denied')
      })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  // Подгружаем сегментатор сразу — к моменту стабилизации видео он готов.
  useEffect(() => subscribePersonSegmentState(setNnState), [])
  useEffect(() => {
    loadPersonSegmenter().catch(() => undefined)
  }, [])

  // Цикл анализа.
  useEffect(() => {
    if (cameraState !== 'live') return
    let stopped = false
    const frameCanvas = document.createElement('canvas')
    const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!

    const analyze = async () => {
      if (stopped || busyRef.current || document.hidden) return
      const video = videoRef.current
      if (!video || !video.videoWidth) return
      busyRef.current = true
      try {
        const scale = Math.min(1, ANALYSIS_DIM / Math.max(video.videoWidth, video.videoHeight))
        const w = Math.max(1, Math.round(video.videoWidth * scale))
        const h = Math.max(1, Math.round(video.videoHeight * scale))
        if (frameCanvas.width !== w || frameCanvas.height !== h) {
          frameCanvas.width = w
          frameCanvas.height = h
        }
        frameCtx.drawImage(video, 0, 0, w, h)
        const imageData = frameCtx.getImageData(0, 0, w, h)

        const personMask = await getPersonMask(imageData)
        if (stopped) return
        if (!personMask) {
          setStatus(nnState === 'error' ? 'error' : 'loading')
          drawOverlay(null, nnState === 'error' ? 'error' : 'loading')
          return
        }
        const mw = personMask.width
        const mh = personMask.height
        const bin = personBinFromCategories(personMask.mask)
        const contour = maskToContour(bin, mw, mh)
        const next = frameStatus(contour, mw, mh)
        setStatus(next)
        drawOverlay(contour, next, mw, mh)

        // Автоопределение левой/правой — только на стабильном top-кадре.
        if (view === 'top' && next === 'ok' && contour && contour.length >= 8) {
          const guess = detectLaterality(contour, true)
          if (guess && guess.confidence >= 0.55) {
            setLaterality({ side: guess.side, confidence: guess.confidence })
            if (foot && guess.side !== foot) onFootGuess?.(guess.side)
          } else if (!guess) {
            setLaterality(null)
          }
        } else if (view !== 'top' || next !== 'ok') {
          setLaterality(null)
        }
      } catch {
        /* кадр пропущен — следующий через LOOP_MS */
      } finally {
        busyRef.current = false
      }
    }

    const frameStatus = (contour: { x: number; y: number }[] | null, mw: number, mh: number): FrameStatus => {
      if (!contour) return 'none'
      const { x0, y0, x1, y1 } = contourBBox(contour)
      const area = (x1 - x0) * (y1 - y0)
      if (area / (mw * mh) < MIN_FOOT_FRACTION) return 'none'
      const edge = Math.max(mw, mh) * 0.015
      if (x0 <= edge || y0 <= edge || x1 >= mw - edge || y1 >= mh - edge) return 'partial'
      const g = guideRect(mw, mh)
      if (x0 >= g.x && x1 <= g.x + g.w && y0 >= g.y && y1 <= g.y + g.h) return 'ok'
      return 'far'
    }

    const drawOverlay = (
      contour: { x: number; y: number }[] | null,
      st: FrameStatus,
      mw?: number,
      mh?: number
    ) => {
      const overlay = overlayRef.current
      const video = videoRef.current
      if (!overlay || !video) return
      const cw = video.clientWidth
      const ch = video.clientHeight
      if (cw === 0 || ch === 0) return
      if (overlay.width !== cw || overlay.height !== ch) {
        overlay.width = cw
        overlay.height = ch
      }
      const ctx = overlay.getContext('2d')!
      ctx.clearRect(0, 0, cw, ch)
      const sx = cw / (mw ?? ANALYSIS_DIM)
      const sy = ch / (mh ?? ANALYSIS_DIM * 0.75)

      // Силуэт: полупрозрачная заливка + плавный контур.
      if (contour && contour.length >= 3) {
        const pts = contour.map((p) => ({ x: p.x * sx, y: p.y * sy }))
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fillStyle = 'rgba(74, 222, 128, 0.16)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)'
        ctx.lineWidth = 3
        ctx.lineJoin = 'round'
        ctx.stroke()
      }

      // Рамка гайда.
      const g = guideRect(cw, ch)
      ctx.strokeStyle = STATUS_COLOR[st]
      ctx.lineWidth = 3
      ctx.setLineDash([10, 8])
      ctx.strokeRect(g.x, g.y, g.w, g.h)
      ctx.setLineDash([])
    }

    const timer = setInterval(() => void analyze(), LOOP_MS)
    void analyze()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [cameraState, view, nnState, foot, onFootGuess])

  async function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const scale = Math.min(1, CAPTURE_DIM / Math.max(video.videoWidth, video.videoHeight))
    const w = Math.max(1, Math.round(video.videoWidth * scale))
    const h = Math.max(1, Math.round(video.videoHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    const blob = await canvasToBlob(canvas)
    onCapture({ blob, imageData, canvas })
  }

  async function handleFile(file: File) {
    const { imageData, canvas } = await fileToImageData(file, CAPTURE_DIM)
    const blob = await canvasToBlob(canvas)
    onCapture({ blob, imageData, canvas })
  }

  // Fallback: камера недоступна/запрещена — старый input capture.
  if (cameraState === 'denied') {
    return (
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <p className="hint">
          Живая камера недоступна{camError ? ` (${camError})` : ''}. Снимите фото штатной камерой
          или выберите из галереи — анализ тот же.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void handleFile(f)
          }}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void handleFile(f)
          }}
        />
        <button className="btn btn-block" onClick={() => fileRef.current?.click()}>
          Сфотографировать
        </button>
        <button className="btn btn-secondary btn-block" onClick={() => galleryRef.current?.click()}>
          Выбрать из галереи
        </button>
      </div>
    )
  }

  const color = STATUS_COLOR[status]
  const hintText =
    view === 'top'
      ? `${STATUS_TEXT[status]} · рядом со стопой положите лист А4`
      : STATUS_TEXT[status]

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div
        style={{
          position: 'relative',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#000',
          aspectRatio: String(videoAspect)
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <canvas
          ref={overlayRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
        {cameraState === 'starting' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text-dim)'
            }}
          >
            Запуск камеры…
          </div>
        )}
      </div>

      <p className="hint" style={{ margin: 0, color, textAlign: 'center', minHeight: '1.2em' }}>
        {hintText}
      </p>

      {view === 'top' && laterality && (
        <p className="hint" style={{ margin: 0, textAlign: 'center' }}>
          Похоже: <strong>{laterality.side === 'left' ? 'левая' : 'правая'}</strong> стопа (
          {Math.round(laterality.confidence * 100)}%) — подтвердите кнопками Л / П ниже
        </p>
      )}

      <button className="btn btn-block" disabled={cameraState !== 'live'} onClick={() => void capture()}>
        Снимать
      </button>
      <button className="btn btn-secondary btn-block" onClick={() => galleryRef.current?.click()}>
        Выбрать из галереи
      </button>
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void handleFile(f)
        }}
      />
    </div>
  )
}
