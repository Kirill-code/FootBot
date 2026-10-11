export type Fit = 'narrow' | 'medium' | 'wide'

export type Purpose = 'casual' | 'running' | 'basketball' | 'trail'

/** Какой подъём стопы вмещает модель (высота над линией подошвы). */
export type InstepTolerance = 'low' | 'medium' | 'high'

/** Одна строка размерной сетки модели. */
export interface SizeEntry {
  us: number
  uk: number
  eu: string
  /** Длина стопы, на которую рассчитан размер, мм. */
  footLengthMm: number
}

/** Модель кроссовок из каталога. */
export interface ShoeModel {
  id: string
  brand: string
  name: string
  purpose: Purpose
  /** Полнота модели. */
  fit: Fit
  /** Тип колодки. */
  last: Fit
  /** Поправка к US-размеру (например, -0.5 — брать на полразмера меньше). */
  fitAdjustment: number
  /** Допуск по подъёму. Если не задано — считается 'medium'. */
  instepTolerance?: InstepTolerance
  sizeChart: SizeEntry[]
  image?: string
  /** Ориентировочная розничная цена, USD. */
  priceUsd?: number
  /** Короткое описание модели. */
  description?: string
}
