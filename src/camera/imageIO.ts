// Общие операции с изображениями для камеры и галереи.

const MAX_BLOB_BYTES = 1024 * 1024 // 1 МБ

/**
 * Читает файл в ImageData + canvas, уменьшая до maxDim px.
 * EXIF-ориентация: телефонные фото почти всегда повёрнуты тегом 274.
 * createImageBitmap(blob, {imageOrientation:'from-image'}) поворачивает
 * пиксели по EXIF (Chrome/FF; при ошибке — откат на обычный bitmap,
 * тогда ориентацию применит декодер <img> при отрисовке на canvas).
 */
export async function fileToImageData(
  file: Blob,
  maxDim: number
): Promise<{ imageData: ImageData; canvas: HTMLCanvasElement }> {
  const scaleBitmap = async (): Promise<ImageBitmap> => {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      return createImageBitmap(file)
    }
  }
  const bmp = await scaleBitmap()
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { imageData: ctx.getImageData(0, 0, w, h), canvas }
}

/** Сериализует canvas в Blob: webp q0.8, fallback jpeg; ≤ 1 МБ. */
export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const toBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

  let blob = await toBlob('image/webp', 0.8)
  if (blob && blob.size <= MAX_BLOB_BYTES) return blob

  for (const q of [0.8, 0.6, 0.4]) {
    blob = await toBlob('image/jpeg', q)
    if (blob && blob.size <= MAX_BLOB_BYTES) return blob
  }
  const last = await toBlob('image/jpeg', 0.4)
  if (!last) throw new Error('Не удалось сохранить фото')
  return last
}
