// Живой камерный видоискатель с NN-сканированием в реальном времени.
// Каждые ~350 мс кадр с видео (даунскейл до 640px) сегментируется
// selfie_multiclass (person-классы), контур силуэта рисуется поверх видео,
// рамка гайда меняет цвет по статусу позиционирования. OpenCV здесь НЕ
// используется — только при финальном анализе в ScanPage.
// Fallback: недоступный/запрещённый getUserMedia → старый input capture.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { FootView, FootContourPoint } from '../analysis/measureFoot'
import type { FootSide } from '../profile/db'
import {
  getPersonMaskAsync,
  resetSegmentWorker,
  subscribePersonSegmentState,
  type PersonSegmentState
} from '../analysis/personSegment'

// Диагностика live-цикла для CDP: число завершённых кадров, время последнего,
// фаза текущего участка. ОДНА ссылка — setHB мутирует её же (иначе CDP-скрипт
// и внутренние счётчики смотрели бы на разные объекты).
const scanHB = { done: 0, last: 0, phase: 'init', phaseT: 0, error: '' }
if (typeof window !== 'undefined') {
  ;(window as unknown as { __scanHB: typeof scanHB }).__scanHB = scanHB
}
import { detectLaterality } from '../analysis/footLaterality'
import { largestComponent, maskToContour, personBinFromCategories } from './liveContour'
import {
  canonForView,
  deltaMask,
  filterPaperComponents,
  fitCanonical,
  lerpTransform,
  transformCanon,
  type CanonPoint,
  type CanonicalTransform,
  type DeltaGrid
} from './canonicalFoot'
import { canvasToBlob, fileToImageData } from './imageIO'
import PixelSneakerLoader from '../ui/PixelSneakerLoader'

const ANALYSIS_DIM = 640 // длинная сторона полного анализ-кадра
const CROP_DIM = 560 // длинная сторона кропа зоны рамки для сегментации
const CROP_MIN_FOOT_FRAC = 0.005 // <0.5% кропа — стопа не найдена
const CAPTURE_DIM = 1600
const LOOP_MS = 400
const OPEN_TIMEOUT_MS = 8000 // таймаут открытия камеры (Android-фриз getUserMedia)
const WATCHDOG_MS = 15_000 // зависший segment()/fetch держит busyRef дольше обычного кадра (<3 с)

export interface CameraShot {
  blob: Blob
  imageData: ImageData
  canvas: HTMLCanvasElement
  /** Live-силуэт момента съёмки (координаты кадра съёмки ≤1600px), только
   * если live-статус был 'ok' и кадр свежий (<2с). null — слепок не зафиксирован. */
  liveContour?: FootContourPoint[] | null
}

interface CameraViewProps {
  view: FootView
  onCapture: (shot: CameraShot) => void
  /** Текущая выбранная стопа (для подтверждения автоопределения). */
  foot?: FootSide
  /** Применить автоопределённую сторону стопы. */
  onFootGuess?: (side: FootSide) => void
  /** false — поставить камеру на паузу (остановка tracks и цикла) без размонтирования. */
  active?: boolean
  /** false — скрыть штатные подписи и кнопки (кастомный chrome родителя, напр. полноэкранный скан). */
  chrome?: boolean
  /** Наружный доступ к спуску/галерее для кастомной кнопки спуска. */
  actionsRef?: MutableRefObject<{ capture: () => void; openGallery: () => void } | null>
  /** Состояние камеры наружу (напр. FullScanScreen ждёт 'live' между шагами). */
  onCameraState?: (state: CameraState) => void
}

type CameraState = 'starting' | 'live' | 'denied'
type FrameStatus = 'loading' | 'error' | 'none' | 'partial' | 'ok'

const STATUS_COLOR: Record<FrameStatus, string> = {
  loading: '#8a8a8a',
  error: '#8a8a8a',
  none: '#f87171',
  partial: '#e8c547',
  ok: '#4ade80'
}

const STATUS_TEXT: Record<FrameStatus, string> = {
  loading: 'Загрузка модели сегментации…',
  error: 'Модель недоступна — снимайте по подсказкам',
  none: 'Стопа не найдена — наведите рамку на стопу',
  partial: 'Отодвиньте — вся стопа не влезает в кадр',
  ok: 'Стопа в кадре ✓'
}

interface GuideRect {
  x: number
  y: number
  w: number
  h: number
}

// Heartbeat live-цикла для диагностики зависаний (window.__scanHB):
// done — сколько кадров обработано, last — timestamp последнего, phase —
// текущий участок ('crop'|'segment'|'contour'|'canon'|'draw'), phaseT —
// timestamp входа в участок.
function setHB(phase: string, finished = false): void {
  scanHB.phase = phase
  scanHB.phaseT = Date.now()
  if (finished) {
    scanHB.done++
    scanHB.last = Date.now()
  }
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

const GHOST_STROKE = 'rgba(255, 255, 255, 0.4)'
const GHOST_TEXT = 'rgba(255, 255, 255, 0.6)'

type Corner = 'tl' | 'tr' | 'bl' | 'br'

/** Доп. слои оверлея: канонический силуэт + дельта реальной маски. */
interface OverlayExtras {
  /** Канон в координатах маски (уже трансформирован). */
  canon: CanonPoint[] | null
  /** Качество фита 0..1 (цвет канона). */
  quality: number
  /** Возраст последнего удачного фита, мс (fade out). */
  age: number
  /** Дельта-зоны: маска за пределами канона. */
  delta: DeltaGrid | null
}

/** Угол рамки, противоположный центру масс маски (по умолчанию — правый нижний). */
function oppositeCorner(contour: { x: number; y: number }[] | null, cw: number, ch: number): Corner {
  if (!contour || contour.length === 0) return 'br'
  let sx = 0
  let sy = 0
  for (const p of contour) {
    sx += p.x
    sy += p.y
  }
  const cx = sx / contour.length
  const cy = sy / contour.length
  return ((cy < ch / 2 ? 'b' : 't') + (cx < cw / 2 ? 'r' : 'l')) as Corner
}

/** Пунктирный placeholder банковской карты (85.6×54, ratio 1.586) в углу рамки. */
function drawCardGhost(ctx: CanvasRenderingContext2D, g: GuideRect, corner: Corner) {
  const cardW = Math.min(g.w * 0.24, g.h * 0.34 * 1.586)
  const cardH = cardW / 1.586
  const m = 8
  const x = corner === 'tl' || corner === 'bl' ? g.x + m : g.x + g.w - m - cardW
  const y = corner === 'tl' || corner === 'tr' ? g.y + m : g.y + g.h - m - cardH
  ctx.save()
  ctx.strokeStyle = GHOST_TEXT
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 4])
  ctx.strokeRect(x, y, cardW, cardH)
  ctx.setLineDash([])
  ctx.fillStyle = GHOST_TEXT
  ctx.font = `${Math.max(9, Math.round(cardH * 0.2))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('карта сюда', x + cardW / 2, y + cardH / 2)
  ctx.restore()
}

/** Оверлей по умолчанию (без маски): рамка + пунктирный канон-подсказка.
 * Используется при смене ракурса — чтобы не оставался слепок шага 1. */
function drawDefaultOverlay(
  overlay: HTMLCanvasElement | null,
  video: HTMLVideoElement | null,
  view: FootView
): void {
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
  const g = guideRect(cw, ch)
  const cv2 = view === 'side' ? 'side' : 'top'
  const defT: CanonicalTransform = {
    cx: g.x + g.w / 2,
    cy: g.y + g.h / 2,
    scale: g.h * 0.38,
    angle: 0,
    quality: 0
  }
  const pts = transformCanon(canonForView(cv2), defT)
  ctx.save()
  ctx.strokeStyle = GHOST_STROKE
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 5])
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
  // Рамка гайда (серая — статус «загрузка/поиск»).
  ctx.strokeStyle = STATUS_COLOR.loading
  ctx.lineWidth = 3
  ctx.setLineDash([10, 8])
  ctx.strokeRect(g.x, g.y, g.w, g.h)
  ctx.setLineDash([])
  if (view === 'top') drawCardGhost(ctx, g, 'br')
}

/** Текстовая шапка видоискателя: цель шага + постоянные напоминания. */
function drawHeader(ctx: CanvasRenderingContext2D, cw: number, view: FootView) {
  const title = view === 'top' ? 'Снимаем СВЕРХУ: длина и ширина' : 'Снимаем СБОКУ: высота подъёма'
  const sub =
    view === 'top'
      ? 'Вся стопа целиком: пятка и все пальцы в кадре'
      : 'Камера у уровня пола: видны и пятка, и носок, стопа стоит на полу'
  const fsTitle = Math.max(14, Math.round(cw / 24))
  const fsSub = Math.max(10, Math.round(cw / 42))
  const pad = 10
  const barH = pad * 2 + fsTitle + 4 + fsSub + 3 + fsSub
  ctx.save()
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.fillRect(0, 0, cw, barH)
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 ${fsTitle}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText(title, pad, pad)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)'
  ctx.font = `${fsSub}px system-ui, sans-serif`
  ctx.fillText(sub, pad, pad + fsTitle + 4)
  ctx.fillStyle = 'rgba(232, 197, 71, 0.95)'
  ctx.fillText('босиком, без носков', pad, pad + fsTitle + 4 + fsSub + 3)
  ctx.restore()
}

export default function CameraView({ view, onCapture, foot, onFootGuess, active = true, chrome = true, actionsRef, onCameraState }: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const busyRef = useRef(false)
  const [cameraState, setCameraState] = useState<CameraState>('starting')
  const [capturing, setCapturing] = useState(false)
  const [videoAspect, setVideoAspect] = useState(4 / 3)
  const [camError, setCamError] = useState('')
  const [camAttempt, setCamAttempt] = useState(0) // инкремент = повторный запуск
  const [nnState, setNnState] = useState<PersonSegmentState>('idle')
  const [status, setStatus] = useState<FrameStatus>('loading')
  const [laterality, setLaterality] = useState<{ side: FootSide; confidence: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  // Диагностика/самовосстановление live-цикла: heartbeat последнего
  // завершённого кадра; супервизор принудительно пересобирает эффект анализа,
  // если кадры перестали идти (любой класс залипания).
  const [cycleGen, setCycleGen] = useState(0)
  const lastDoneRef = useRef(0)
  const drawOverlayRef = useRef<((c: { x: number; y: number }[] | null, s: FrameStatus, mw?: number, mh?: number) => void) | null>(null)
  // Пропы в refs — чтобы эффект анализа не пересоздавался на рендерах родителя.
  const footRef = useRef(foot)
  footRef.current = foot
  const onFootGuessRef = useRef(onFootGuess)
  onFootGuessRef.current = onFootGuess
  const chromeRef = useRef(chrome)
  chromeRef.current = chrome

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  // Гарантированный stop при размонтировании (даже если эффект запуска мёртв).
  useEffect(() => stopStream, [])

  // Запуск камеры: таймаут 8 с → abort → ОДИН повтор с минимальными
  // constraints. Вторая ошибка/таймаут → denied + кнопка «Повторить».
  useEffect(() => {
    if (!active) return
    const gm = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
    if (!gm) {
      setCamError('getUserMedia не поддерживается')
      setCameraState('denied')
      return
    }
    let cancelled = false
    stopStream()
    setCameraState('starting')

    const openCamera = (constraints: MediaStreamConstraints, timeoutMs: number): Promise<MediaStream> =>
      new Promise((resolve, reject) => {
        let settled = false
        const ctrl = new AbortController()
        const timer = setTimeout(() => {
          settled = true
          ctrl.abort() // Chrome с signal отпускает запрос/индикатор камеры
          reject(new DOMException('Timeout открытия камеры', 'TimeoutError'))
        }, timeoutMs)
        gm({ ...constraints, signal: ctrl.signal } as MediaStreamConstraints)
          .then((s) => {
            if (settled) {
              // Камера открылась после таймаута — поток не нужен.
              s.getTracks().forEach((t) => t.stop())
              return
            }
            settled = true
            clearTimeout(timer)
            resolve(s)
          })
          .catch((e: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(e)
          })
      })

    const FULL: MediaStreamConstraints = {
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }
    const MINIMAL: MediaStreamConstraints = { video: { facingMode: 'environment' }, audio: false }

    ;(async () => {
      let s: MediaStream
      try {
        s = await openCamera(FULL, OPEN_TIMEOUT_MS)
      } catch {
        if (cancelled) return
        try {
          s = await openCamera(MINIMAL, OPEN_TIMEOUT_MS)
        } catch (e) {
          if (cancelled) return
          setCamError(e instanceof Error ? e.message : String(e))
          setCameraState('denied')
          return
        }
      }
      if (cancelled) {
        s.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = s
      // Смерть камеры mid-session (другой вкладкой/ОС — track 'ended',
      // stream 'inactive'): авто-переоткрытие через механизм retry.
      let streamEnded = false
      const onStreamEnd = () => {
        if (cancelled || streamEnded) return
        streamEnded = true
        if (document.hidden) return // в фоне не дёргаем — cleanup эффекта при разворачивании
        stopStream()
        setCameraState('starting')
        setCamAttempt((n) => n + 1)
      }
      s.getTracks().forEach((tr) => {
        tr.onended = onStreamEnd
      })
      ;(s as MediaStream & { oninactive?: () => void }).oninactive = onStreamEnd
      const v = videoRef.current
      if (v) {
        v.srcObject = s
        v.onloadedmetadata = () => {
          // Аспект контейнера = аспект потока, иначе objectFit cover
          // кадрирует кадр и оверлей разъедется.
          if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight)
          v.play().catch(() => undefined)
        }
        // Часть Android не стартует воспроизведение с первого раза.
        v.onloadeddata = () => v.play().catch(() => undefined)
        v.play().catch(() => undefined)
      }
      setCameraState('live')
    })()

    return () => {
      cancelled = true
      stopStream()
    }
    // view в deps: смена ракурса = полный перезапуск потока с пустым
    // состоянием сканирования (пользователь просил «пустой кеш» на шаге 2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, camAttempt, view])

  // Подписка на состояние сегментатора: статусы приходят и из worker'а
  // (live-цикл) и из главно-поточного fallback (финальный анализ).
  useEffect(() => subscribePersonSegmentState(setNnState), [])

  // Состояние камеры наружу (FullScanScreen ждёт 'live' между шагами).
  const onCameraStateRef = useRef(onCameraState)
  onCameraStateRef.current = onCameraState
  useEffect(() => {
    onCameraStateRef.current?.(cameraState)
    if (cameraState === 'live') wasLiveRef.current = true
  }, [cameraState])

  // Сглаживание канонического силуэта между кадрами (вне эффекта цикла).
  const canonRef = useRef<{ t: CanonicalTransform; lastSeen: number } | null>(null)
  // Последний успешно отрисованный кадр — для супервизора зависания.
  const lastFrameRef = useRef(0)
  // Счётчик зависаний (нет кадров >10 с) — для видимого статуса и баннера.
  const [hangs, setHangs] = useState(0)
  // Последний успешный live-результат: контур в координатах полного
  // анализ-кадра (640-пространство) + статус + timestamp. Источник слепка
  // и маски финального анализа — единый источник истины «что видел юзер».
  const liveSnapshotRef = useRef<{
    contour: { x: number; y: number }[]
    status: FrameStatus
    frameW: number
    frameH: number
    at: number
  } | null>(null)
  // Камера уже была жива хотя бы раз — 'starting' после этого = перезапуск.
  const wasLiveRef = useRef(false)
  // Подряд идущие кадры без videoWidth — признак умершего потока (когда
  // track.onended по какой-то причине не пришёл).
  const noVideoCount = useRef(0)

  // Смена ракурса: сброс ВСЕГО аналитического состояния шага (канон,
  // сглаживание, laterality, статус, счётчики) + оверлей в дефолт (подсказка
  // рамки). NN-модель НЕ трогаем — «пустой кеш» про состояние сканирования.
  useEffect(() => {
    canonRef.current = null
    noVideoCount.current = 0
    busyRef.current = false
    liveSnapshotRef.current = null
    setLaterality(null)
    setStatus('loading')
    drawDefaultOverlay(overlayRef.current, videoRef.current, view)
  }, [view])

  // Цикл анализа.
  useEffect(() => {
    if (!active || cameraState !== 'live') return
    let stopped = false
    const frameCanvas = document.createElement('canvas')
    const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!
    // Кроп зоны рамки (источник для сегментации) и темповый canvas дельта-зон.
    const cropCanvas = document.createElement('canvas')
    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })!
    const deltaCanvas = document.createElement('canvas')
    const deltaCtx = deltaCanvas.getContext('2d')!

    const analyze = async () => {
      if (stopped || busyRef.current || document.hidden) return
      const video = videoRef.current
      if (!video || !video.videoWidth) {
        noVideoCount.current++
        // ≥5 подряд (~2 с) — поток мёртв: та же процедура восстановления,
        // что и по track.onended. Дедупликация: при 'starting' не повторяем.
        if (noVideoCount.current >= 5 && cameraState === 'live') {
          noVideoCount.current = 0
          stopStream()
          setCameraState('starting')
          setCamAttempt((n) => n + 1)
        }
        return
      }
      noVideoCount.current = 0
      busyRef.current = true
      setHB('crop')
      // Watchdog: segment() может зависнуть ВНУТРИ wasm без исключения.
      // Сегментация — в worker'е (главный поток свободен), поэтому сторож
      // отстреливается даже при мёртвом wasm: terminate + пересоздание.
      const watchdog = setTimeout(() => {
        if (stopped) return
        busyRef.current = false
        // Не оставляем застывшую обводку: чистим оверлей, статус «загрузка».
        drawOverlay(null, 'loading')
        setStatus('loading')
        resetSegmentWorker()
      }, WATCHDOG_MS)
      try {
        const scale = Math.min(1, ANALYSIS_DIM / Math.max(video.videoWidth, video.videoHeight))
        const w = Math.max(1, Math.round(video.videoWidth * scale))
        const h = Math.max(1, Math.round(video.videoHeight * scale))
        if (frameCanvas.width !== w || frameCanvas.height !== h) {
          frameCanvas.width = w
          frameCanvas.height = h
        }
        frameCtx.drawImage(video, 0, 0, w, h)

        // Сегментируем ТОЛЬКО зону рамки + 12% запас: ищем не по всему кадру
        // (пользователь держит камеру верно), меньше картинка — segment()
        // быстрее и короче блокировки главного потока.
        const fg = guideRect(w, h)
        const mrgX = fg.w * 0.12
        const mrgY = fg.h * 0.12
        const cx0 = Math.max(0, Math.round(fg.x - mrgX))
        const cy0 = Math.max(0, Math.round(fg.y - mrgY))
        const cw = Math.min(w - cx0, Math.round(fg.w + 2 * mrgX))
        const ch = Math.min(h - cy0, Math.round(fg.h + 2 * mrgY))
        const cropScale = Math.min(1, CROP_DIM / Math.max(cw, ch))
        const crw = Math.max(1, Math.round(cw * cropScale))
        const crh = Math.max(1, Math.round(ch * cropScale))
        if (cropCanvas.width !== crw || cropCanvas.height !== crh) {
          cropCanvas.width = crw
          cropCanvas.height = crh
        }
        cropCtx.drawImage(frameCanvas, cx0, cy0, cw, ch, 0, 0, crw, crh)
        const cropData = cropCtx.getImageData(0, 0, crw, crh)

        setHB('segment')
        const personMask = await getPersonMaskAsync(cropData)
        if (stopped) return
        if (!personMask) {
          setStatus(nnState === 'error' ? 'error' : 'loading')
          drawOverlay(null, nnState === 'error' ? 'error' : 'loading')
          return
        }
        setHB('contour')
        const mw = personMask.width
        const mh = personMask.height
        const bin = personBinFromCategories(personMask.mask)
        // Бумага/лист не должны попадать в силуэт (иначе канон фиттится на
        // лист) — исключаем paper-like компоненты по яркости/насыщенности.
        const noPaper = filterPaperComponents(bin, mw, mh, cropData.data)
        const comp = largestComponent(noPaper, mw, mh)
        const compBin = comp && comp.area >= mw * mh * CROP_MIN_FOOT_FRAC ? comp.bin : null
        // Контур сразу переводим в координаты полного анализ-кадра
        // (оверлей масштабирует из них же).
        const contourCrop = compBin ? maskToContour(compBin, mw, mh) : null
        const contour = contourCrop
          ? contourCrop.map((p) => ({ x: p.x / cropScale + cx0, y: p.y / cropScale + cy0 }))
          : null
        const next = frameStatusCrop(contourCrop, mw, mh)
        setStatus(next)

        // Канонический силуэт: стабильная форма вместо сырого дёргающегося
        // контура. Трансформация сглаживается lerp между кадрами; при
        // пропадании маски держим последнюю 1.5 с (fade out 300 мс).
        setHB('canon')
        const now = Date.now()
        let canonT: CanonicalTransform | null = null
        if (compBin) {
          const fitted = fitCanonical(compBin, mw, mh, view === 'side' ? 'side' : 'top')
          if (fitted) {
            const prev = canonRef.current
            canonT = prev ? lerpTransform(prev.t, fitted, 0.25) : fitted
            canonRef.current = { t: canonT, lastSeen: now }
          }
        }
        if (!canonT && canonRef.current && now - canonRef.current.lastSeen < 1500) {
          canonT = canonRef.current.t
        }
        let canonPts: CanonPoint[] | null = null
        let delta: DeltaGrid | null = null
        if (canonT) {
          canonPts = transformCanon(canonForView(view === 'side' ? 'side' : 'top'), canonT)
          if (compBin) delta = deltaMask(compBin, mw, mh, canonPts, 4)
        }
        // Канон и дельта из кроп-координат в полный анализ-кадр.
        const fullCanon = canonT
          ? {
              cx: canonT.cx / cropScale + cx0,
              cy: canonT.cy / cropScale + cy0,
              scale: canonT.scale / cropScale,
              angle: canonT.angle,
              quality: canonT.quality
            }
          : null
        const canonFull = fullCanon
          ? transformCanon(canonForView(view === 'side' ? 'side' : 'top'), fullCanon)
          : null
        const deltaFull = delta
          ? { ...delta, x0: delta.x0 / cropScale + cx0, y0: delta.y0 / cropScale + cy0, step: delta.step / cropScale }
          : null
        setHB('draw')
        drawOverlay(contour, next, w, h, {
          canon: canonFull,
          quality: canonT?.quality ?? 0,
          age: canonT && canonRef.current ? now - canonRef.current.lastSeen : 0,
          delta: deltaFull
        })
        // Кадр отрисован: супервизор зависания молчит, счётчик сброшен.
        lastFrameRef.current = Date.now()
        if (hangs > 0) setHangs(0)
        // Единый источник истины слепка: контур в 640-координатах полного кадра.
        liveSnapshotRef.current = contour
          ? { contour, status: next, frameW: w, frameH: h, at: Date.now() }
          : null

        // Автоопределение левой/правой — только на стабильном top-кадре.
        if (view === 'top' && next === 'ok' && contour && contour.length >= 8) {
          const guess = detectLaterality(contour, true)
          if (guess && guess.confidence >= 0.55) {
            setLaterality({ side: guess.side, confidence: guess.confidence })
            if (footRef.current && guess.side !== footRef.current) onFootGuessRef.current?.(guess.side)
          } else if (!guess) {
            setLaterality(null)
          }
        } else if (view !== 'top' || next !== 'ok') {
          setLaterality(null)
        }
      } catch (e) {
        // CDP-отладка: текст последнего исключения фазы (зависание — в HB).
        scanHB.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        /* кадр пропущен — следующий через LOOP_MS */
      } finally {
        // выполняется ВСЕГДА: фазы помечаются до await-точек, счётчик живёт
        // даже при исключении в drawOverlay.
        clearTimeout(watchdog)
        busyRef.current = false
        lastDoneRef.current = Date.now()
        setHB('done', true)
      }
    }

    // Статусы по кропу: вне рамки ничего не ищем — кроп И ЕСТЬ зона поиска.
    // Мало person-пикселей → 'none'; касание краёв кропа → 'partial' (стопа
    // не влезает); иначе → 'ok'. 'far' не нужен — искать вне рамки нечего.
    const frameStatusCrop = (contour: { x: number; y: number }[] | null, cw: number, ch: number): FrameStatus => {
      if (!contour) return 'none'
      const { x0, y0, x1, y1 } = contourBBox(contour)
      const area = (x1 - x0) * (y1 - y0)
      if (area / (cw * ch) < CROP_MIN_FOOT_FRAC) return 'none'
      const edge = Math.max(cw, ch) * 0.015
      if (x0 <= edge || y0 <= edge || x1 >= cw - edge || y1 >= ch - edge) return 'partial'
      return 'ok'
    }

    const drawOverlay = (
      contour: { x: number; y: number }[] | null,
      st: FrameStatus,
      mw?: number,
      mh?: number,
      extras?: OverlayExtras
    ) => {
      drawOverlayRef.current = drawOverlay
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
      const g = guideRect(cw, ch)

      // Канонический силуэт — основной контур. Если маска ещё ни разу не
      // детектилась — канон в дефолтной позиции рамки, пунктир (гайд).
      const canon = extras?.canon
      if (canon && canon.length >= 3) {
        const pts = canon.map((p) => ({ x: p.x * sx, y: p.y * sy }))
        const age = extras?.age ?? 0
        // Fade out за 300 мс после 1.5 с без маски.
        const alpha = age < 1200 ? 1 : Math.max(0, (1500 - age) / 300)
        const good = (extras?.quality ?? 0) > 0.5
        const rgb = good ? '74, 222, 128' : '232, 197, 71'
        ctx.save()
        ctx.globalAlpha = alpha
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.fillStyle = `rgba(${rgb}, 0.10)`
        ctx.fill()
        ctx.strokeStyle = `rgba(${rgb}, 0.95)`
        ctx.lineWidth = 2.5
        ctx.lineJoin = 'round'
        ctx.stroke()
        // Дельта: где реальная маска выходит за канон (подъём, ширина) —
        // оранжевая заливка 25%.
        const d = extras?.delta
        if (d && d.cells.some((c) => c)) {
          if (deltaCanvas.width !== d.gw || deltaCanvas.height !== d.gh) {
            deltaCanvas.width = d.gw
            deltaCanvas.height = d.gh
          }
          const img = deltaCtx.createImageData(d.gw, d.gh)
          for (let i = 0; i < d.cells.length; i++) {
            if (d.cells[i]) {
              const o = i * 4
              img.data[o] = 255
              img.data[o + 1] = 150
              img.data[o + 2] = 0
              img.data[o + 3] = 64
            }
          }
          deltaCtx.putImageData(img, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(deltaCanvas, d.x0 * sx, d.y0 * sy, d.gw * d.step * sx, d.gh * d.step * sy)
        }
        ctx.restore()
      } else {
        const defT: CanonicalTransform = {
          cx: g.x + g.w / 2,
          cy: g.y + g.h / 2,
          scale: g.h * 0.38,
          angle: 0,
          quality: 0
        }
        const pts = transformCanon(canonForView(view === 'side' ? 'side' : 'top'), defT).map((p) => ({ x: p.x * sx, y: p.y * sy }))
        ctx.save()
        ctx.strokeStyle = GHOST_STROKE
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 5])
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }

      // Реальная маска — тонкий пунктир (без заливки: читается дельта).
      if (contour && contour.length >= 3) {
        const pts = contour.map((p) => ({ x: p.x * sx, y: p.y * sy }))
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.7)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Рамка гайда.
      ctx.strokeStyle = STATUS_COLOR[st]
      ctx.lineWidth = 3
      ctx.setLineDash([10, 8])
      ctx.strokeRect(g.x, g.y, g.w, g.h)
      ctx.setLineDash([])

      // Зона банковской карты (только top, статичный placeholder).
      if (view === 'top') drawCardGhost(ctx, g, oppositeCorner(contour, cw, ch))

      // Текстовая шапка поверх всего (в кастомном chrome рисует родитель).
      if (chromeRef.current) drawHeader(ctx, cw, view)
    }

    // Супервизор зависания: нет успешных кадров >10 с (камера жива, вкладка
    // видима) — красный статус + полный перезапуск (камера + worker
    // сегментации). Скрытая вкладка кадры не ждёт — ок.
    lastFrameRef.current = Date.now()
    const superTimer = setInterval(() => {
      if (stopped || document.hidden) return
      if (Date.now() - lastFrameRef.current > 10_000) {
        lastFrameRef.current = Date.now() // дедуп: один перезапуск на эпизод
        setHangs((c) => c + 1)
        stopStream()
        resetSegmentWorker()
        setCameraState('starting')
        setCamAttempt((n) => n + 1)
      }
    }, 1000)

    const timer = setInterval(() => void analyze(), LOOP_MS)
    void analyze()
    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(superTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cameraState, view, nnState, cycleGen])

  // Супервизор: если завершённые кадры не появляются дольше 10 с при живой
  // камере — цикл анализа залип (любая причина): принудительная пересборка
  // эффекта (свежий interval, сброшенный busy) + пересоздание сегментатора.
  useEffect(() => {
    if (!active || cameraState !== 'live') return
    lastDoneRef.current = Date.now()
    const sup = setInterval(() => {
      if (document.hidden) {
        lastDoneRef.current = Date.now()
        return
      }
      if (Date.now() - lastDoneRef.current > 10_000) {
        busyRef.current = false
        resetSegmentWorker()
        drawOverlayRef.current?.(null, 'loading')
        setStatus('loading')
        setHangs((c) => c + 1)
        lastDoneRef.current = Date.now()
        setCycleGen((g) => g + 1)
      }
    }, 5_000)
    return () => clearInterval(sup)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cameraState, cycleGen])

  async function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    // Залепший цикл (нет кадров >4 с): не снимать по протухшему liveContour —
    // видимый статус + процедура перезапуска, как у супервизора.
    if (Date.now() - lastDoneRef.current > 4000) {
      setHangs((c) => c + 1)
      busyRef.current = false
      resetSegmentWorker()
      setStatus('loading')
      setCameraState('starting')
      setCamAttempt((n) => n + 1)
      return
    }
    setCapturing(true)
    try {
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
    // Слепок — live-силуэт, который пользователь ВИДЕЛ при спуске (статус 'ok',
    // свежесть <2 с). Пересегментация полного кадра убрана: другой вход NN
    // давал другую маску и лишние 1–3 с после нажатия. Координаты: 640-кадр →
    // кадр съёмки (оба — пропорциональные даунскейлы видео, аспект общий).
    const snap = liveSnapshotRef.current
    let liveContour: FootContourPoint[] | null = null
    if (snap && snap.status === 'ok' && Date.now() - snap.at < 2000 && snap.frameW > 0) {
      const k = w / snap.frameW
      liveContour = snap.contour.map((p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }))
    }
    console.log('[capture] liveContour', {
      pts: liveContour?.length ?? 0,
      status: snap?.status ?? 'нет кадров',
      ageMs: snap ? Date.now() - snap.at : -1
    })
    onCapture({ blob, imageData, canvas, liveContour })
    } finally {
      setCapturing(false)
    }
  }

  async function handleFile(file: File) {
    setCapturing(true)
    try {
      const { imageData, canvas } = await fileToImageData(file, CAPTURE_DIM)
      const blob = await canvasToBlob(canvas)
      onCapture({ blob, imageData, canvas })
    } finally {
      setCapturing(false)
    }
  }

  // Внешний доступ к спуску/галерее (кастомная кнопка спуска родителя).
  useEffect(() => {
    if (!actionsRef) return
    actionsRef.current = {
      capture: () => void capture(),
      openGallery: () => galleryRef.current?.click()
    }
    return () => {
      actionsRef.current = null
    }
  })

  // Fallback: камера недоступна/запрещена — старый input capture.
  if (cameraState === 'denied') {
    return (
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <p className="hint">
          Живая камера недоступна{camError ? ` (${camError})` : ''}. Снимите фото штатной камерой
          или выберите из галереи — анализ тот же.
        </p>
        <button
          className="btn btn-block"
          onClick={() => {
            setCamError('')
            setCamAttempt((n) => n + 1)
          }}
        >
          Повторить запуск камеры
        </button>
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
  // На шаге top жёлтые статусы и «ок» подсказывают про карту в углу рамки.
  const hintText =
    view === 'top'
      ? `${STATUS_TEXT[status]} · положите банковскую карту в углу рамки (или лист А4, если камера высоко)`
      : STATUS_TEXT[status]

  // Видимые статусы сбоев (раньше — молчаливые): зависание цикла / перезапуск камеры.
  const noticeText =
    hangs > 0
      ? `Перезапускаем камеру/анализ… (зависание, попытка ${hangs})`
      : cameraState === 'starting' && wasLiveRef.current
        ? 'Камера перезапускается…'
        : null
  const noticeColor = hangs > 0 ? '#f87171' : '#e8c547'
  const hangBanner = hangs > 2

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
          autoPlay
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
              color: 'var(--text-dim)',
              background: 'rgba(0,0,0,0.35)'
            }}
          >
            <PixelSneakerLoader size={72} text="Запуск камеры…" />
          </div>
        )}
        {capturing && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(0,0,0,0.55)'
            }}
          >
            <PixelSneakerLoader size={64} text="Сохраняем кадр…" />
          </div>
        )}
        {!active && cameraState === 'live' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text-dim)',
              background: 'rgba(0,0,0,0.5)'
            }}
          >
            Камера на паузе
          </div>
        )}
      </div>

      {/* Статусы сбоев показываем даже в кастомном chrome (fullscan). */}
      {noticeText && (
        <p className="hint" style={{ margin: 0, color: noticeColor, textAlign: 'center', fontWeight: 600 }}>
          {noticeText}
        </p>
      )}
      {hangBanner && (
        <div className="card" style={{ borderColor: '#f87171', display: 'grid', gap: 10 }}>
          <p className="hint" style={{ color: '#f87171', margin: 0, fontWeight: 600 }}>
            Анализ завис. Переснимите ракурс или выберите фото из галереи.
          </p>
          <button className="btn btn-block" onClick={() => galleryRef.current?.click()}>
            Выбрать фото из галереи
          </button>
        </div>
      )}

      {chrome && (
        <>
          <p className="hint" style={{ margin: 0, color, textAlign: 'center', minHeight: '1.2em' }}>
            {(status === 'loading' || status === 'error') && (
              <span style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }}>
                <PixelSneakerLoader size={20} />
              </span>
            )}
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
        </>
      )}
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
