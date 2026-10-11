import type { Fit, Purpose, ShoeModel, SizeEntry } from '../catalog/types'

/**
 * Профиль пользователя для скоринга (структурно совместим с UserProfile
 * из ./profile — дополнительные поля используются, если заполнены).
 */
export interface ScoringProfile {
  /** Длина стопы, мм. */
  footLengthMm: number
  /** Полнота стопы (как заявлено пользователем). */
  fullness: Fit
  /** Целевое назначение. */
  purpose: Purpose
  /** Высота подъёма, мм (если измерена). */
  instepHeightMm?: number
  /** Ширина переднего отдела, мм (если измерена). */
  ballWidthMm?: number
  /** Отношение ширины к длине (если рассчитано). */
  widthRatio?: number
}

export type Verdict = 'perfect' | 'good' | 'poor'

export type VolumeLevel = 'low' | 'medium' | 'high'

/** Раскладка итогового Score по компонентам (0..1 каждый). */
export interface ScoreBreakdown {
  S_length: number
  S_width: number
  S_volume: number
  S_last: number
  S_purpose: number
}

export interface ScoreResult {
  score: number
  recommendedUs: number
  recommendedEu: string
  verdict: Verdict
  breakdown: ScoreBreakdown
  /** Человекочитаемые рекомендации на русском. */
  notes: string[]
}

/** Припуск на свободу в носке, мм. */
const ALLOWANCE = 10
/** Шкала штрафа по длине, мм. */
const LENGTH_SCALE = 10

const FIT_ORDER: Fit[] = ['narrow', 'medium', 'wide']
const VOLUME_ORDER: VolumeLevel[] = ['low', 'medium', 'high']

/** Типичное instep/length у взрослых — 0.28–0.36. */
const INSTEP_LOW = 0.28
const INSTEP_HIGH = 0.36

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

/**
 * Эффективная полнота стопы: если известен widthRatio (или его можно
 * получить из ballWidthMm/длины) — он уточняет заявленную полноту:
 * <0.36 — узкая, 0.36–0.40 — средняя, >0.40 — широкая.
 */
function effectiveFullness(profile: ScoringProfile): Fit {
  const ratio =
    profile.widthRatio ??
    (profile.ballWidthMm != null && profile.footLengthMm > 0
      ? profile.ballWidthMm / profile.footLengthMm
      : null)
  if (ratio == null) return profile.fullness
  if (ratio < 0.36) return 'narrow'
  if (ratio > 0.4) return 'wide'
  return 'medium'
}

/** Уровень подъёма стопы по отношению высоты подъёма к длине. */
function instepLevel(profile: ScoringProfile): VolumeLevel | null {
  if (profile.instepHeightMm == null || profile.footLengthMm <= 0) return null
  const r = profile.instepHeightMm / profile.footLengthMm
  if (r < INSTEP_LOW) return 'low'
  if (r > INSTEP_HIGH) return 'high'
  return 'medium'
}

/**
 * S_volume: уровень подъёма стопы против допуска модели.
 * Подъём в пределах допуска (или ниже него) → 1; на один уровень выше → 0.5;
 * конфликт (на два уровня и выше) → 0. Без данных о подъёме → 0.5 (нейтрально).
 */
function volumeSimilarity(profile: ScoringProfile, shoe: ShoeModel): number {
  const level = instepLevel(profile)
  if (level === null) return 0.5
  const foot = VOLUME_ORDER.indexOf(level)
  const tolerance = VOLUME_ORDER.indexOf(shoe.instepTolerance ?? 'medium')
  if (foot <= tolerance) return 1
  if (foot === tolerance + 1) return 0.5
  return 0
}

/** Базовый размер: строка сетки с длиной, ближайшей к целевой (L + allowance). */
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

const FULLNESS_LABELS: Record<Fit, string> = { narrow: 'узкая', medium: 'средняя', wide: 'широкая' }

/**
 * Score = 100 * (0.40*S_length + 0.20*S_width + 0.15*S_volume + 0.10*S_last + 0.15*S_purpose)
 *
 * - S_length  = max(0, 1 - |L_in(US_final) - L - allowance| / 10), allowance = 10 мм
 * - S_width   = полнота (уточнённая widthRatio/ballWidthMm) vs fit модели:
 *               1 совпадение, 0.5 соседние, 0 противоположные
 * - S_volume  = подъём стопы vs instepTolerance модели: 1 в пределах допуска,
 *               0.5 на уровень выше допуска, 0 конфликт; без данных — 0.5
 * - S_last    = полнота vs колодке (как S_width)
 * - S_purpose = 1 совпадение, 0.5 пересечение, 0.2 нет
 *
 * US* = argmin по sizeChart |footLengthMm - (L + allowance)|, затем + fitAdjustment,
 * затем ближайший имеющийся размер сетки (US_final). При равной дистанции
 * (полуразмер между целыми) выбирается меньший размер.
 */
export function scoreModel(profile: ScoringProfile, shoe: ShoeModel): ScoreResult {
  if (shoe.sizeChart.length === 0) {
    return {
      score: 0,
      recommendedUs: 0,
      recommendedEu: '—',
      verdict: 'poor',
      breakdown: { S_length: 0, S_width: 0, S_volume: 0, S_last: 0, S_purpose: 0 },
      notes: ['Нет размерной сетки — подбор невозможен']
    }
  }

  const base = pickBaseEntry(shoe.sizeChart, profile.footLengthMm + ALLOWANCE)
  const usFinal = base.us + shoe.fitAdjustment
  const finalEntry = pickFinalEntry(shoe.sizeChart, usFinal)

  const sLength = Math.max(
    0,
    1 - Math.abs(finalEntry.footLengthMm - profile.footLengthMm - ALLOWANCE) / LENGTH_SCALE
  )
  const fullness = effectiveFullness(profile)
  const sWidth = fitSimilarity(fullness, shoe.fit)
  const sVolume = volumeSimilarity(profile, shoe)
  const sLast = fitSimilarity(fullness, shoe.last)
  const sPurpose = purposeSimilarity(profile.purpose, shoe.purpose)

  const breakdown: ScoreBreakdown = {
    S_length: sLength,
    S_width: sWidth,
    S_volume: sVolume,
    S_last: sLast,
    S_purpose: sPurpose
  }

  const score = Math.round(
    100 * (0.4 * sLength + 0.2 * sWidth + 0.15 * sVolume + 0.1 * sLast + 0.15 * sPurpose)
  )

  const verdict: Verdict = score >= 85 ? 'perfect' : score >= 70 ? 'good' : 'poor'

  const notes: string[] = []
  if (sLength <= 0) {
    notes.push('По длине размер подходит слабо — рассмотрите другую модель')
  } else if (sLength >= 0.3 && sLength <= 0.7) {
    notes.push('Между размерами — для примерки берите больший')
  }
  if (fullness !== profile.fullness) {
    notes.push(
      `По соотношению ширины к длине стопа ${FULLNESS_LABELS[fullness]} — учтено в оценке`
    )
  }
  if (sWidth === 0) {
    notes.push('Узкая колодка модели — возможно давление на вашу стопу')
  }
  const instep = instepLevel(profile)
  if (instep === 'high' && (shoe.instepTolerance ?? 'medium') !== 'high') {
    notes.push('Высокий подъём — выбирайте модели с выше кроем')
  } else if (instep === 'medium' && shoe.instepTolerance === 'low') {
    notes.push('Средний подъём — в низкой колодке может быть тесно')
  }
  if (sPurpose === 0.2) {
    notes.push('Назначение модели не совпадает с вашей целью')
  }
  if (shoe.fitAdjustment < 0) {
    notes.push('Модель большемерит — учтена поправка «меньше на размер»')
  } else if (shoe.fitAdjustment > 0) {
    notes.push('Модель маломерит — учтена поправка «больше на размер»')
  }

  return {
    score,
    recommendedUs: finalEntry.us,
    recommendedEu: finalEntry.eu,
    verdict,
    breakdown,
    notes
  }
}
