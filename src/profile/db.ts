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

export const db = new Dexie('footbot') as Dexie & {
  photos: EntityTable<FootPhoto, 'id'>
  measurements: EntityTable<Measurement, 'id'>
}

db.version(1).stores({
  photos: '++id, foot, createdAt',
  measurements: '++id, createdAt'
})
