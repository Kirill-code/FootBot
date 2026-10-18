// Web Worker для NN-сегментации «человек/фон» (MediaPipe tasks-vision).
// КРИТИЧНО: segment() может уйти в бесконечный цикл ВНУТРИ wasm — если это
// главный поток, UI мёртв навсегда (setTimeout-сторож не отстреливается).
// В worker'е зависший поток изолирован: главный поток жив, сторож CameraView
// делает terminate + recreate.
//
// Протокол:
//   → { type: 'segment', id, imageData: {width, height, data} }  (data transfer)
//   ← { type: 'state', state: 'loading' | 'ready' | 'error' }
//   ← { type: 'segment', id, mask: Uint8Array | null, width, height }  (mask transfer)

/// <reference lib="webworker" />

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite'

const MODEL_FETCH_TIMEOUT_MS = 25_000

type ImageSegmenterT = import('@mediapipe/tasks-vision').ImageSegmenter

let segmenter: ImageSegmenterT | null = null
let initPromise: Promise<boolean> | null = null

const ctx = self as unknown as Worker

function postState(state: 'loading' | 'ready' | 'error') {
  ctx.postMessage({ type: 'state', state })
}

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

/** Ленивая инициализация сегментатора (модель ~16 МБ, один раз). */
function ensureInit(): Promise<boolean> {
  if (segmenter) return Promise.resolve(true)
  if (!initPromise) {
    initPromise = (async () => {
      try {
        postState('loading')
        // self-hosted wasm рядом с приложением: worker-чанк в assets/ → ../mediapipe.
        const wasmPath = new URL('../mediapipe/', self.location.href).href
        const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(wasmPath)
        const modelBlob = await fetchWithTimeout(MODEL_URL, MODEL_FETCH_TIMEOUT_MS)
        const modelUrl = URL.createObjectURL(modelBlob)
        try {
          segmenter = await ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
            runningMode: 'IMAGE',
            outputCategoryMask: true
          })
        } finally {
          URL.revokeObjectURL(modelUrl)
        }
        postState('ready')
        return true
      } catch (e) {
        ctx.postMessage({ type: 'log', text: `[segmentWorker] init failed: ${String(e)}` })
        postState('error')
        initPromise = null // следующий вызов попробует заново
        return false
      }
    })()
  }
  return initPromise
}

interface SegmentRequest {
  type: 'segment'
  id: number
  imageData: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }
}

ctx.onmessage = async (e: MessageEvent<SegmentRequest>) => {
  const msg = e.data
  if (msg.type !== 'segment') return
  const { id, imageData } = msg
  try {
    if (!(await ensureInit())) {
      ctx.postMessage({ type: 'segment', id, mask: null })
      return
    }
    const img = new ImageData(imageData.data, imageData.width, imageData.height)
    const bmp = await createImageBitmap(img)
    let result
    try {
      // tasks-vision принимает CanvasImageSource; в worker — ImageBitmap.
      result = segmenter!.segment(bmp)
    } catch {
      // Фallback-шимма: часть сборок требует canvas-источник.
      const oc = new OffscreenCanvas(bmp.width, bmp.height)
      oc.getContext('2d')!.drawImage(bmp, 0, 0)
      result = segmenter!.segment(oc as unknown as HTMLCanvasElement)
    }
    bmp.close()
    const mask = result.categoryMask
    if (!mask) {
      ctx.postMessage({ type: 'segment', id, mask: null })
      return
    }
    const arr = mask.getAsUint8Array()
    ctx.postMessage({ type: 'segment', id, mask: arr, width: mask.width, height: mask.height }, [arr.buffer])
  } catch {
    ctx.postMessage({ type: 'segment', id, mask: null })
  }
}
