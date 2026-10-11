import Dexie, { type EntityTable } from 'dexie'

export type FootSide = 'left' | 'right'

/** Фото стопы (сырое или обработанное). */
export interface FootPhoto {
  id?: number
  foot: FootSide
  createdAt: number
  blob: Blob
  /** Измеренная длина стопы, мм (null пока не измерено). */
  footLengthMm: number | null
  /** Измеренная ширина стопы, мм (null пока не измерено). */
  footWidthMm: number | null
}

/** Источник замера: автоматический (OpenCV) или ручной ввод. */
export type MeasurementSource = 'manual' | 'opencv'

/** Замеры стопы, полученные после обработки фото или введённые вручную. */
export interface Measurement {
  id?: number
  createdAt: number
  footLengthMm: number
  footWidthMm: number
  source: MeasurementSource
  /** Контур стопы в пикселях фото (только для source: 'opencv'). */
  contour?: Array<{ x: number; y: number }>
}

export type VolumeHint = 'low' | 'medium' | 'high'

/** Итоговая модель стопы из мультисъёмки (3 ракурса). */
export interface FootModelRecord {
  id?: number
  foot: FootSide
  createdAt: number
  /** Данные ракурсов (null — ракурс пропущен или не измерен). */
  lengthMm: number | null
  widthMm: number | null
  instepHeightMm: number | null
  ballWidthMm: number | null
  widthRatio: number | null
  volumeHint: VolumeHint | null
  inconsistent: boolean
  source: MeasurementSource
}

export const db = new Dexie('footbot') as Dexie & {
  photos: EntityTable<FootPhoto, 'id'>
  measurements: EntityTable<Measurement, 'id'>
  footModels: EntityTable<FootModelRecord, 'id'>
}

db.version(1).stores({
  photos: '++id, foot, createdAt',
  measurements: '++id, createdAt'
})

// v2: модель стопы из мультисъёмки. Старые photos/measurements сохраняются.
db.version(2).stores({
  photos: '++id, foot, createdAt',
  measurements: '++id, createdAt',
  footModels: '++id, foot, createdAt'
})
