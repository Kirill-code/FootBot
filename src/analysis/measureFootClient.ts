// Клиент Web Worker'а анализа. Лениво создаёт module worker, передаёт
// пиксели/маску transfer'ом (zero-copy).
// Сторожа: init-защита 20 с (первый ответ → worker не поднялся → terminate +
// синхронный fallback на главном потоке) и таймаут 45 с на ракурс (зависший
// wasm → terminate + reject — ScanPage покажет плашку перезапуска).
// Если Worker недоступен/упал — откат на старый синхронный путь
// (OpenCV + measureFoot в главном потоке).

import type { FootMeasurement, FootView } from './measureFoot'

const MEASURE_TIMEOUT_MS = 45_000 // на ракурс
const INIT_TIMEOUT_MS = 20_000 // первый ответ: worker + OpenCV не поднялись

// window.__scanHB.analyze — точка диагностики зависания анализа (CDP).
function hbAnalyze(state: string) {
  const w = window as unknown as { __scanHB?: { analyze?: { state: string; at: number } } }
  const hb = (w.__scanHB ??= {} as never) as { analyze?: { state: string; at: number } }
  hb.analyze = { state, at: Date.now() }
}

let worker: Worker | null = null
let workerFailed = false
let workerReady = false
let nextId = 1

interface Pending {
  resolve: (m: FootMeasurement) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<number, Pending>()

function failAllPending(e: Error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(e)
  }
  pending.clear()
}

function destroyWorker() {
  worker?.terminate()
  worker = null
  workerReady = false
  workerFailed = true
  failAllPending(new Error('Worker анализа недоступен'))
}

/** Сторож зависания анализа (таймаут ракурса): убить worker — следующий
 * вызов пересоздаст. workerFailed НЕ выставляется: это не фатальная
 * недоступность, а подвисший прогон. */
export function resetMeasureWorker(): void {
  worker?.terminate()
  worker = null
  workerReady = false
  failAllPending(new Error('Анализ завис (таймаут 45 с)'))
  console.warn('[analyze:worker] resetMeasureWorker: terminate + recreate')
}

function getWorker(): Worker | null {
  if (workerFailed) return null
  if (!worker) {
    try {
      worker = new Worker(new URL('./measureWorker.ts', import.meta.url))
    } catch {
      workerFailed = true
      return null
    }
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { id: number; result?: FootMeasurement; error?: string; progress?: string }
      if (data.progress !== undefined) {
        // Точки прогресса worker'а — в CDP видно, где виснет.
        console.log(`[analyze:worker] ${data.progress}`)
        hbAnalyze(`worker:${data.progress}`)
        return
      }
      const { id, result, error } = data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      clearTimeout(p.timer)
      workerReady = true
      if (error !== undefined || !result) p.reject(new Error(error || 'Анализ не дал результата'))
      else p.resolve(result)
    }
    worker.onerror = () => destroyWorker()
    worker.onmessageerror = () => destroyWorker()
  }
  return worker
}

/** Старый синхронный путь — fallback при недоступности Worker. */
async function syncFallback(imageData: ImageData, view: FootView): Promise<FootMeasurement> {
  const { loadOpenCv } = await import('./opencvLoader')
  const { measureFoot } = await import('./measureFoot')
  await loadOpenCv()
  return measureFoot(imageData, { view })
}

/**
 * Анализ фото в Worker (или синхронно, если Worker недоступен).
 * Пиксели imageData передаются transfer'ом (копией) — исходный буфер
 * у вызывающего кода остаётся нетронутым.
 */
export async function measureFootAsync(
  imageData: ImageData,
  view: FootView
): Promise<FootMeasurement> {
  const w = getWorker()
  if (!w) return syncFallback(imageData, view)
  // Первый ответ worker'а (init + OpenCV ~16 МБ): короче лимит — зависший
  // init не должен выглядеть как «анализ идёт».
  const timeoutMs = workerReady ? MEASURE_TIMEOUT_MS : INIT_TIMEOUT_MS
  return new Promise<FootMeasurement>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      if (!workerReady) {
        // Init-защита: worker не поднялся за 20 с → навсегда на главный поток.
        destroyWorker()
        console.warn('[analyze:worker] init timeout — синхронный fallback')
        syncFallback(imageData, view).then(resolve, reject)
        return
      }
      hbAnalyze('timeout')
      resetMeasureWorker()
      reject(new Error('Анализ завис (таймаут 45 с)'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    hbAnalyze('sent')
    // Transfer отсоединяет буферы — копируем, иначе после анализа кадр
    // вызывающего опустошается и повторный анализ ломался бы.
    const imgCopy = new Uint8ClampedArray(imageData.data)
    try {
      w.postMessage(
        {
          id,
          view,
          imageData: { width: imageData.width, height: imageData.height, data: imgCopy }
        },
        [imgCopy.buffer as ArrayBuffer]
      )
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
