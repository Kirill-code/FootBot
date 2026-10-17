// Клиент Web Worker'а анализа. Лениво создаёт module worker, передаёт
// пиксели/маску transfer'ом (zero-copy), по таймауту 90 с → reject.
// Если Worker недоступен/упал — откат на старый синхронный путь
// (OpenCV + measureFoot в главном потоке).

import type { FootMeasurement, FootView, PersonMask } from './measureFoot'

const TIMEOUT_MS = 90_000

let worker: Worker | null = null
let workerFailed = false
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
  workerFailed = true
  failAllPending(new Error('Worker анализа недоступен'))
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
      const { id, result, error } = e.data as { id: number; result?: FootMeasurement; error?: string }
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      clearTimeout(p.timer)
      if (error !== undefined || !result) p.reject(new Error(error || 'Анализ не дал результата'))
      else p.resolve(result)
    }
    worker.onerror = () => destroyWorker()
    worker.onmessageerror = () => destroyWorker()
  }
  return worker
}

/** Старый синхронный путь — fallback при недоступности Worker. */
async function syncFallback(
  imageData: ImageData,
  view: FootView,
  personMask: PersonMask | null | undefined
): Promise<FootMeasurement> {
  const { loadOpenCv } = await import('./opencvLoader')
  const { measureFoot } = await import('./measureFoot')
  await loadOpenCv()
  return measureFoot(imageData, { view, personMask: personMask ?? undefined })
}

/**
 * Анализ фото в Worker (или синхронно, если Worker недоступен).
 * Пиксели imageData передаются transfer'ом — буферы imageData после вызова
 * отсоединены (используйте canvas/blob из вызывающего кода повторно).
 */
export async function measureFootAsync(
  imageData: ImageData,
  view: FootView,
  personMask?: PersonMask | null
): Promise<FootMeasurement> {
  const w = getWorker()
  if (!w) return syncFallback(imageData, view, personMask)
  const pm = personMask ?? undefined
  return new Promise<FootMeasurement>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Анализ занял больше 90 секунд — попробуйте переснять при лучшем освещении'))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    // Transfer отсоединяет буферы — копируем, иначе после анализа кадр/маска
    // вызывающего опустошаются и повторный анализ ломался бы.
    const imgCopy = new Uint8ClampedArray(imageData.data)
    const pmCopy = pm ? pm.mask.slice() : undefined
    const transfers: ArrayBuffer[] = [imgCopy.buffer as ArrayBuffer]
    if (pmCopy) transfers.push(pmCopy.buffer as ArrayBuffer)
    try {
      w.postMessage(
        {
          id,
          view,
          imageData: { width: imageData.width, height: imageData.height, data: imgCopy },
          personMask: pm && pmCopy ? { width: pm.width, height: pm.height, mask: pmCopy } : undefined
        },
        transfers
      )
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
