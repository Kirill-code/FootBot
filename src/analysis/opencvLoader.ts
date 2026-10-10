// Ленивая загрузка OpenCV.js (wasm, ~8 МБ gzip).
// Загружается только при первом сканировании — в main-бандл не попадает.
import type { CV } from '@techstark/opencv-js'

export type OpenCv = CV

export type OpenCvLoadState = 'idle' | 'loading' | 'ready' | 'error'

let loadPromise: Promise<OpenCv> | null = null
let resolved: OpenCv | null = null
let state: OpenCvLoadState = 'idle'
let error: unknown = null

const listeners = new Set<(state: OpenCvLoadState) => void>()

function setState(s: OpenCvLoadState) {
  state = s
  for (const l of listeners) l(s)
}

/** Подписка на изменения состояния загрузки. Возвращает функцию отписки. */
export function subscribeOpenCvState(cb: (state: OpenCvLoadState) => void): () => void {
  listeners.add(cb)
  cb(state)
  return () => {
    listeners.delete(cb)
  }
}

/** Синхронный доступ к загруженному OpenCV. Бросает ошибку, если не загружен. */
export function getOpenCv(): OpenCv {
  if (!resolved) throw new Error('OpenCV не загружен: сначала вызовите loadOpenCv()')
  return resolved
}

/** Singleton-загрузка OpenCV.js. Повторные вызовы возвращают тот же промис. */
export function loadOpenCv(): Promise<OpenCv> {
  if (!loadPromise) {
    loadPromise = doLoad()
  }
  return loadPromise
}

async function doLoad(): Promise<OpenCv> {
  setState('loading')
  try {
    // Динамический import — тяжёлый wasm-пакет уходит в отдельный ленивый чанк.
    const mod = (await import('@techstark/opencv-js')) as unknown as {
      default?: unknown
    }
    let cv: unknown = mod.default ?? mod
    // В некоторых окружениях модуль возвращает Promise до инициализации wasm.
    if (cv != null && typeof (cv as PromiseLike<unknown>).then === 'function') {
      cv = await (cv as PromiseLike<unknown>)
    }
    resolved = cv as OpenCv
    setState('ready')
    return resolved
  } catch (e) {
    error = e
    setState('error')
    throw e
  }
}

/** Последняя ошибка загрузки (актуальна при состоянии 'error'). */
export function getOpenCvError(): unknown {
  return error
}
