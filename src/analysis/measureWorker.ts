// Web Worker для анализа фото: OpenCV wasm + measureFoot выполняются
// вне главного потока — UI не фризится на десятки секунд (Android Chrome).
// OpenCV инициализируется один раз, при первом сообщении.
//
// Протокол:
//   запрос:  { id, view, imageData: {width, height, data: Uint8ClampedArray} }
//            (буфер передаётся transfer'ом)
//   ответ:   { id, result: FootMeasurement } | { id, error: string }

/// <reference lib="webworker" />

import { loadOpenCv } from './opencvLoader'
import { measureFoot, type FootMeasurement, type FootView } from './measureFoot'

interface MeasureRequest {
  id: number
  view: FootView
  imageData: { width: number; height: number; data: Uint8ClampedArray }
}

let readyPromise: Promise<unknown> | null = null
function ensureReady(): Promise<unknown> {
  if (!readyPromise) readyPromise = loadOpenCv()
  return readyPromise
}

const ctx = self as unknown as Worker

ctx.onmessage = async (e: MessageEvent<MeasureRequest>) => {
  const { id, view, imageData } = e.data
  const t0 = Date.now()
  const progress = (state: string) => ctx.postMessage({ id, progress: state })
  try {
    progress('init-ok')
    await ensureReady()
    progress('opencv-ready')
    // measureFoot принимает ImageDataLike {data,width,height} — в харнессе так же.
    const result: FootMeasurement = measureFoot(imageData as unknown as ImageData, { view })
    progress(`measure-done ${Date.now() - t0}`)
    ctx.postMessage({ id, result })
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
