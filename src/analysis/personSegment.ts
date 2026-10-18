// Ленивый загрузчик NN-сегментации «человек/фон» (MediaPipe tasks-vision,
// selfie_multiclass_256x256). Модель грузится с CDN Google (16.4 МБ, один раз,
// кешируется service worker'ом); wasm self-hosted в public/mediapipe/.
// Любая недоступность → null: measureFoot работает в классическом режиме.

import type { PersonMask } from './measureFoot'

type TasksVision = typeof import('@mediapipe/tasks-vision')
type ImageSegmenter = import('@mediapipe/tasks-vision').ImageSegmenter

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite'

let modPromise: Promise<TasksVision> | null = null
function loadTasksVision(): Promise<TasksVision> {
  if (!modPromise) modPromise = import('@mediapipe/tasks-vision')
  return modPromise
}

let loadPromise: Promise<ImageSegmenter | null> | null = null

export type PersonSegmentState = 'idle' | 'loading' | 'ready' | 'error'

let state: PersonSegmentState = 'idle'
let lastError: unknown = null
const listeners = new Set<(s: PersonSegmentState) => void>()

function setState(s: PersonSegmentState) {
  state = s
  for (const l of listeners) l(s)
}

export function subscribePersonSegmentState(cb: (s: PersonSegmentState) => void): () => void {
  listeners.add(cb)
  cb(state)
  return () => {
    listeners.delete(cb)
  }
}

export function getPersonSegmentError(): unknown {
  return lastError
}

// Отладочный хук: прямой доступ к worker-пайплайну из консоли/CDP.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __footbotDebug: Record<string, unknown> }).__footbotDebug = {
    getPersonMaskAsync: (...args: unknown[]) => getPersonMaskAsync(args[0] as ImageData),
    resetSegmentWorker: () => resetSegmentWorker(),
    subscribePersonSegmentState,
    getPersonSegmentError: () => String(lastError ?? ''),
    getState: () => state
  }
}

/** Запросы на сброс сегментатора (после ошибок сегментации/зависаний). */
let segmenterReset: (() => void) | null = null

/** Поколение загрузки: инкрементируется при сбросе. doLoad чужого поколения
 * не публикует устаревший сегментатор/состояние (гонка reset vs завершение). */
let generation = 0

function resetSegmenterSingleton() {
  segmenterReset?.()
}

/** Singleton-загрузка сегментатора. null — недоступен (сеть/ошибка), классика. */
export function loadPersonSegmenter(): Promise<ImageSegmenter | null> {
  if (!loadPromise) {
    loadPromise = doLoad()
    segmenterReset = () => {
      generation++
      const stale = loadPromise
      loadPromise = null
      segmenterReset = null
      setState('idle')
      // Устаревший экземпляр, если он всё же материализовался — закрываем.
      stale
        ?.then((seg) => {
          try {
            seg?.close()
          } catch {
            /* уже закрыт */
          }
        })
        .catch(() => undefined)
    }
  }
  return loadPromise
}

const MODEL_FETCH_TIMEOUT_MS = 25_000

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Blob> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`Скачивание модели: HTTP ${resp.status}`)
    return await resp.blob()
  } finally {
    clearTimeout(timer)
  }
}

async function doLoad(): Promise<ImageSegmenter | null> {
  const gen = generation
  setState('loading')
  try {
    // base './' (HashRouter/PWA на GH Pages): ассеты от корня приложения.
    const base = document.querySelector('base')?.getAttribute('href') ?? './'
    const wasmPath = new URL('mediapipe/', new URL(base, document.baseURI)).href
    const { FilesetResolver, ImageSegmenter } = await loadTasksVision()
    const vision = await FilesetResolver.forVisionTasks(wasmPath)
    // Модель качаем сами, с таймаутом: createFromOptions фетчил бы её без
    // всякого лимита — зависший fetch мёртво залипал бы live-цикл.
    const modelBlob = await fetchWithTimeout(MODEL_URL, MODEL_FETCH_TIMEOUT_MS)
    const modelUrl = URL.createObjectURL(modelBlob)
    let segmenter: ImageSegmenter | null = null
    try {
      segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true
      })
    } finally {
      URL.revokeObjectURL(modelUrl)
    }
    if (gen !== generation) {
      // Пока грузили — вызвали reset: экземпляр не публикуем.
      try {
        segmenter?.close()
      } catch {
        /* уже закрыт */
      }
      return null
    }
    setState('ready')
    return segmenter
  } catch (e) {
    if (gen === generation) {
      lastError = e
      setState('error')
    }
    // Ошибку не кешируем — следующий вызов попробует загрузить заново.
    loadPromise = null
    segmenterReset = null
    return null
  }
}

/** Принудительный сброс сегментатора (watchdog CameraView): закрывает текущий
 * экземпляр (если он уже создан) и сбрасывает singleton — следующий кадр
 * пересоздаст сегментатор с нуля. */
export function resetPersonSegmenter(): void {
  resetSegmenterSingleton()
}

// --- Worker-сегментация: wasm в отдельном потоке ---------------------------
// segment() может зависнуть ВНУТРИ wasm навсегда. В главном потоке это
// убивает весь UI (сторож setTimeout не отстреливается). В worker'е
// зависший поток изолирован: сторож делает terminate, следующий кадр
// пересоздаёт worker. Главно-поточный getPersonMask остаётся fallback.

const SEG_TIMEOUT_MS = 20_000

let segWorker: Worker | null = null
let segWorkerFailed = false
let nextSegId = 1

interface SegPending {
  resolve: (m: PersonMask | null) => void
  timer: ReturnType<typeof setTimeout>
}
const segPending = new Map<number, SegPending>()

function destroySegWorker() {
  segWorker?.terminate()
  segWorker = null
  for (const p of segPending.values()) {
    clearTimeout(p.timer)
    p.resolve(null) // кадр пропущен; следующий кадр пересоздаст worker
  }
  segPending.clear()
}

/** Watchdog: убить worker сегментации — следующий кадр пересоздаст. */
export function resetSegmentWorker(): void {
  destroySegWorker()
  setState('idle')
}

function getSegWorker(): Worker | null {
  if (segWorkerFailed) return null
  if (!segWorker) {
    try {
      segWorker = new Worker(new URL('./segmentWorker.ts', import.meta.url))
    } catch {
      segWorkerFailed = true
      return null
    }
    segWorker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'state'; state: PersonSegmentState }
        | { type: 'log'; text: string }
        | { type: 'segment'; id: number; mask: Uint8Array | null; width: number; height: number }
      if (msg.type === 'state') {
        if (msg.state === 'error') {
          // Инициализация в worker неработоспособна (напр. tasks-vision требует
          // DOM) — детерминированная ошибка, повторы бессмысленны. Перманентный
          // откат на главно-поточный путь, чтобы live-поиск работал.
          segWorkerFailed = true
          destroySegWorker()
        }
        setState(msg.state)
        return
      }
      if (msg.type === 'log') {
        console.error(msg.text)
        return
      }
      const p = segPending.get(msg.id)
      if (!p) return
      segPending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg.mask ? { mask: msg.mask, width: msg.width, height: msg.height } : null)
    }
    segWorker.onerror = (e) => {
      console.error('[segmentWorker] onerror:', e.message, e.filename, e.lineno)
      segWorkerFailed = true
      destroySegWorker()
      setState('error')
    }
    segWorker.onmessageerror = (e) => {
      console.error('[segmentWorker] onmessageerror:', String(e))
      segWorkerFailed = true
      destroySegWorker()
      setState('error')
    }
  }
  return segWorker
}

/**
 * Сегментация в Web Worker (предпочтительно) с откатом на главный поток.
 * Пиксели копируются и передаются transfer'ом — исходный imageData не
 * отсоединяется (вызывающий код использует его дальше, напр. paper-фильтр).
 * allowMainThreadFallback: false (live-цикл) — при недоступном/зависшем
 * worker возвращаем null (кадр пропущен, UI не блокируется главно-поточным
 * wasm); true (analyze) — главно-поточный getPersonMask как последний
 * резорт ПОСЛЕ worker-таймаута.
 */
export async function getPersonMaskAsync(
  imageData: ImageData,
  opts: { allowMainThreadFallback?: boolean } = {}
): Promise<PersonMask | null> {
  const allowMainThreadFallback = opts.allowMainThreadFallback ?? true
  const w = getSegWorker()
  if (!w) return allowMainThreadFallback ? getPersonMask(imageData) : null
  return new Promise<PersonMask | null>((resolve) => {
    const id = nextSegId++
    const copy = imageData.data.slice()
    const timer = setTimeout(() => {
      segPending.delete(id)
      resetSegmentWorker()
      if (allowMainThreadFallback) {
        // Worker завис — последний резорт: главный поток (только analyze).
        getPersonMask(imageData).then(resolve, () => resolve(null))
      } else {
        resolve(null)
      }
    }, SEG_TIMEOUT_MS)
    segPending.set(id, { resolve, timer })
    try {
      w.postMessage(
        { type: 'segment', id, imageData: { width: imageData.width, height: imageData.height, data: copy } },
        [copy.buffer as ArrayBuffer]
      )
    } catch {
      segPending.delete(id)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

// Переиспользуемый canvas — не плодим DOM-элемент на каждый кадр.
let frameCanvas: HTMLCanvasElement | null = null

/**
 * Сегментирует кадр: классы 0..5 (0 фон, 1 волосы, 2 кожа тела, 3 кожа лица,
 * 4 одежда, 5 аксессуары). person = 2|3|4.
 * @returns маска классов + размеры, или null при любой недоступности.
 * При ошибке самого сегментатора — одна попытка мягкого пересоздания,
 * чтобы live-цикл не залипал на протухшем состоянии.
 */
export async function getPersonMask(imageData: ImageData): Promise<PersonMask | null> {
  const segmenter = await loadPersonSegmenter()
  if (!segmenter) return null
  if (!frameCanvas) frameCanvas = document.createElement('canvas')
  frameCanvas.width = imageData.width
  frameCanvas.height = imageData.height
  frameCanvas.getContext('2d')!.putImageData(imageData, 0, 0)
  try {
    const result = segmenter.segment(frameCanvas)
    const mask = result.categoryMask
    if (!mask) return null
    return {
      mask: mask.getAsUint8Array(),
      width: mask.width,
      height: mask.height
    }
  } catch (e) {
    // MediaPipe может протухнуть (внутренняя ошибка графа) — сбрасываем
    // singleton, следующий кадр пересоздаст сегментатор.
    lastError = e
    try {
      segmenter.close()
    } catch {
      /* уже закрыт */
    }
    resetSegmenterSingleton()
    return null
  }
}
