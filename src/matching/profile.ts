import { db } from '../profile/db'
import type { Fit, Purpose } from '../catalog/types'

/** Предпочтение посадки: вплотную или с запасом. */
export type FitPreference = 'snug' | 'comfort'

/** Профиль пользователя для подбора моделей. */
export interface UserProfile {
  /** Длина стопы, мм. */
  footLengthMm: number
  /** Ширина стопы, мм (если измерена). */
  footWidthMm?: number
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
    return {
      footLengthMm: parsed.footLengthMm,
      footWidthMm: typeof parsed.footWidthMm === 'number' ? parsed.footWidthMm : undefined,
      fullness: parsed.fullness ?? 'medium',
      purpose: parsed.purpose ?? 'casual',
      fitPreference: parsed.fitPreference ?? 'comfort'
    }
  } catch {
    return null
  }
}

/**
 * Загружает профиль: длина/ширина — из последнего замера в Dexie,
 * полнота/назначение/посадка — из настроек в localStorage.
 * Если замеров нет — полный профиль из localStorage (ручной ввод).
 */
export async function loadProfile(): Promise<UserProfile | null> {
  let measurement: { footLengthMm: number; footWidthMm: number } | null = null
  try {
    measurement = (await db.measurements.orderBy('createdAt').reverse().first()) ?? null
  } catch {
    measurement = null
  }

  const stored = readStoredProfile()

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
