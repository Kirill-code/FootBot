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

/** Запросы на сброс сегментатора (после ошибок сегментации). */
let segmenterReset: (() => void) | null = null

function resetSegmenterSingleton() {
  segmenterReset?.()
}

/** Singleton-загрузка сегментатора. null — недоступен (сеть/ошибка), классика. */
export function loadPersonSegmenter(): Promise<ImageSegmenter | null> {
  if (!loadPromise) {
    loadPromise = doLoad()
    segmenterReset = () => {
      loadPromise = null
      segmenterReset = null
      setState('idle')
    }
  }
  return loadPromise
}

async function doLoad(): Promise<ImageSegmenter | null> {
  setState('loading')
  try {
    // base './' (HashRouter/PWA на GH Pages): ассеты от корня приложения.
    const base = document.querySelector('base')?.getAttribute('href') ?? './'
    const wasmPath = new URL('mediapipe/', new URL(base, document.baseURI)).href
    const { FilesetResolver, ImageSegmenter } = await loadTasksVision()
    const vision = await FilesetResolver.forVisionTasks(wasmPath)
    const segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputCategoryMask: true
    })
    setState('ready')
    return segmenter
  } catch (e) {
    lastError = e
    setState('error')
    return null
  }
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
