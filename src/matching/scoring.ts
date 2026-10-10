import type { Fit, Purpose, ShoeModel, SizeEntry } from '../catalog/types'

/** Профиль пользователя для скоринга (структурно совместим с UserProfile из ./profile). */
export interface ScoringProfile {
  /** Длина стопы, мм. */
  footLengthMm: number
  /** Полнота стопы. */
  fullness: Fit
  /** Целевое назначение. */
  purpose: Purpose
}

export type Verdict = 'perfect' | 'good' | 'poor'

export interface ScoreResult {
  score: number
  recommendedUs: number
  recommendedEu: string
  verdict: Verdict
}

/** Припуск на свободу в носке, мм. */
const ALLOWANCE = 10
/** Шкала штрафа по длине, мм. */
const LENGTH_SCALE = 10

const FIT_ORDER: Fit[] = ['narrow', 'medium', 'wide']

/** Пары назначений с частичным пересечением. */
const PURPOSE_OVERLAP: Record<Purpose, Purpose[]> = {
  casual: ['running', 'basketball', 'trail'],
  running: ['casual', 'trail'],
  basketball: ['casual'],
  trail: ['casual', 'running']
}

/** 1 — совпадение, 0.5 — соседние, 0 — противоположные. */
function fitSimilarity(a: Fit, b: Fit): number {
  if (a === b) return 1
  const d = Math.abs(FIT_ORDER.indexOf(a) - FIT_ORDER.indexOf(b))
  return d === 1 ? 0.5 : 0
}

/** 1 — совпадение, 0.5 — пересечение, 0.2 — нет. */
function purposeSimilarity(a: Purpose, b: Purpose): number {
  if (a === b) return 1
  if (PURPOSE_OVERLAP[a].includes(b)) return 0.5
  return 0.2
}

/** Базовый размер: строка сетки с длиной, ближайшей к длине стопы. */
function pickBaseEntry(chart: SizeEntry[], footLengthMm: number): SizeEntry {
  let best = chart[0]
  for (const e of chart) {
    if (Math.abs(e.footLengthMm - footLengthMm) < Math.abs(best.footLengthMm - footLengthMm)) {
      best = e
    }
  }
  return best
}

/** Итоговый размер с учётом fitAdjustment: строка сетки, ближайшая к US_final. */
function pickFinalEntry(chart: SizeEntry[], usFinal: number): SizeEntry {
  let best = chart[0]
  for (const e of chart) {
    if (Math.abs(e.us - usFinal) < Math.abs(best.us - usFinal)) {
      best = e
    }
  }
  return best
}

/**
 * Score = 100 * (0.45 * S_length + 0.25 * S_width + 0.15 * S_last + 0.15 * S_purpose)
 *
 * - S_length = max(0, 1 - |L_in(US_final) - L - allowance| / 10), allowance = 10 мм
 * - S_width  = 1 совпадение полноты, 0.5 соседние, 0 противоположные
 * - S_last   = аналогично по колодке
 * - S_purpose = 1 совпадение, 0.5 пересечение, 0.2 нет
 *
 * US* = argmin по sizeChart |footLengthMm - (L + allowance)|, затем + fitAdjustment,
 * затем ближайший имеющийся размер сетки (US_final). При равной дистанции
 * (полуразмер между целыми) выбирается меньший размер.
 */
export function scoreModel(profile: ScoringProfile, shoe: ShoeModel): ScoreResult {
  if (shoe.sizeChart.length === 0) {
    return { score: 0, recommendedUs: 0, recommendedEu: '—', verdict: 'poor' }
  }

  const base = pickBaseEntry(shoe.sizeChart, profile.footLengthMm + ALLOWANCE)
  const usFinal = base.us + shoe.fitAdjustment
  const finalEntry = pickFinalEntry(shoe.sizeChart, usFinal)

  const sLength = Math.max(
    0,
    1 - Math.abs(finalEntry.footLengthMm - profile.footLengthMm - ALLOWANCE) / LENGTH_SCALE
  )
  const sWidth = fitSimilarity(profile.fullness, shoe.fit)
  const sLast = fitSimilarity(profile.fullness, shoe.last)
  const sPurpose = purposeSimilarity(profile.purpose, shoe.purpose)

  const score = Math.round(100 * (0.45 * sLength + 0.25 * sWidth + 0.15 * sLast + 0.15 * sPurpose))

  const verdict: Verdict = score >= 85 ? 'perfect' : score >= 70 ? 'good' : 'poor'

  return {
    score,
    recommendedUs: finalEntry.us,
    recommendedEu: finalEntry.eu,
    verdict
  }
}
