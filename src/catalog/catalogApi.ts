import type { ShoeModel } from './types'

let cache: ShoeModel[] | null = null

/** Загружает каталог из public/catalog/catalog.json. */
export async function loadCatalog(): Promise<ShoeModel[]> {
  if (cache) return cache
  const res = await fetch('catalog/catalog.json')
  if (!res.ok) throw new Error(`Не удалось загрузить каталог: ${res.status}`)
  cache = (await res.json()) as ShoeModel[]
  return cache
}

/** Ищет модель по id. */
export async function getModelById(id: string): Promise<ShoeModel | undefined> {
  const catalog = await loadCatalog()
  return catalog.find((m) => m.id === id)
}

/**
 * Абсолютный URL фото модели. В JSON пути относительны папки catalog/,
 * поэтому подставляем BASE_URL, чтобы они работали на GitHub Pages.
 */
export function catalogImageUrl(image: string): string {
  if (/^(https?:|\/)/.test(image)) return image
  return `${import.meta.env.BASE_URL}catalog/${image}`
}
