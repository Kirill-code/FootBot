import { db } from '../profile/db'
import type { VolumeHint } from '../profile/db'
import type { Fit, Purpose } from '../catalog/types'

/** Предпочтение посадки: вплотную или с запасом. */
export type FitPreference = 'snug' | 'comfort'

/** Профиль пользователя для подбора моделей. */
export interface UserProfile {
  /** Длина стопы, мм. */
  footLengthMm: number
  /** Ширина стопы, мм (если измерена). */
  footWidthMm?: number
  /** Высота подъёма, мм (если измерена). */
  instepHeightMm?: number
  /** Ширина переднего отдела, мм (если измерена). */
  ballWidthMm?: number
  /** Отношение ширины к длине (если рассчитано). */
  widthRatio?: number
  /** Оценка объёма стопы из мультисъёмки. */
  volumeHint?: VolumeHint
  /** Полнота стопы. */
  fullness: Fit
  /** Целевое назначение. */
  purpose: Purpose
  /** Предпочтение посадки. */
  fitPreference: FitPreference
}

const LS_KEY = 'footbot.profile'

type StoredProfile = UserProfile

function readStoredProfile(): StoredProfile | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredProfile>
    if (typeof parsed.footLengthMm !== 'number' || parsed.footLengthMm <= 0) return null
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    return {
      footLengthMm: parsed.footLengthMm,
      footWidthMm: num(parsed.footWidthMm),
      instepHeightMm: num(parsed.instepHeightMm),
      ballWidthMm: num(parsed.ballWidthMm),
      widthRatio: num(parsed.widthRatio),
      volumeHint: parsed.volumeHint ?? undefined,
      fullness: parsed.fullness ?? 'medium',
      purpose: parsed.purpose ?? 'casual',
      fitPreference: parsed.fitPreference ?? 'comfort'
    }
  } catch {
    return null
  }
}

/**
 * Загружает профиль. Приоритет — последняя модель стопы из Dexie (длина,
 * ширина, подъём, ширина переднего отдела, объём); полнота/назначение/посадка
 * — из настроек в localStorage. Если модели нет или в ней нет длины — старое
 * поведение: последний замер measurements, иначе полный профиль из localStorage.
 */
export async function loadProfile(): Promise<UserProfile | null> {
  const stored = readStoredProfile()

  let footModel: {
    lengthMm: number | null
    widthMm: number | null
    instepHeightMm: number | null
    ballWidthMm: number | null
    widthRatio: number | null
    volumeHint: VolumeHint | null
  } | null = null
  try {
    footModel = (await db.footModels.orderBy('createdAt').reverse().first()) ?? null
  } catch {
    footModel = null
  }

  if (footModel && footModel.lengthMm != null) {
    return {
      footLengthMm: footModel.lengthMm,
      footWidthMm: footModel.widthMm ?? undefined,
      instepHeightMm: footModel.instepHeightMm ?? undefined,
      ballWidthMm: footModel.ballWidthMm ?? undefined,
      widthRatio: footModel.widthRatio ?? undefined,
      volumeHint: footModel.volumeHint ?? undefined,
      fullness: stored?.fullness ?? 'medium',
      purpose: stored?.purpose ?? 'casual',
      fitPreference: stored?.fitPreference ?? 'comfort'
    }
  }

  let measurement: { footLengthMm: number; footWidthMm: number } | null = null
  try {
    measurement = (await db.measurements.orderBy('createdAt').reverse().first()) ?? null
  } catch {
    measurement = null
  }

  if (measurement) {
    return {
      footLengthMm: measurement.footLengthMm,
      footWidthMm: measurement.footWidthMm,
      fullness: stored?.fullness ?? 'medium',
      purpose: stored?.purpose ?? 'casual',
      fitPreference: stored?.fitPreference ?? 'comfort'
    }
  }

  return stored
}

/** Сохраняет настройки профиля (полнота, назначение, посадка) в localStorage. */
export function saveProfileSettings(settings: {
  fullness: Fit
  purpose: Purpose
  fitPreference: FitPreference
}): void {
  const current = readStoredProfile()
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        footLengthMm: current?.footLengthMm,
        footWidthMm: current?.footWidthMm,
        instepHeightMm: current?.instepHeightMm,
        ballWidthMm: current?.ballWidthMm,
        widthRatio: current?.widthRatio,
        volumeHint: current?.volumeHint,
        ...settings
      } satisfies Partial<StoredProfile>)
    )
  } catch {
    /* localStorage недоступен — игнорируем */
  }
}

/** Сохраняет полный профиль (ручной ввод без скана) в localStorage. */
export function saveManualProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(profile satisfies StoredProfile))
  } catch {
    /* localStorage недоступен — игнорируем */
  }
}
