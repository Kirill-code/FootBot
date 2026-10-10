import { describe, expect, it } from 'vitest'
import { scoreModel } from './scoring'
import type { ScoringProfile } from './scoring'
import type { ShoeModel, SizeEntry } from '../catalog/types'

/** Стандартная сетка: шаг 10 мм, US8 = 260 мм. */
function grid(startUs = 6, startMm = 240, count = 8, stepUs: number | null = null): SizeEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const us = stepUs === null ? startUs + i : startUs + i * stepUs
    return { us, uk: us - 1, eu: String(38.5 + i), footLengthMm: startMm + i * 10 }
  })
}

function shoe(overrides: Partial<ShoeModel> = {}): ShoeModel {
  return {
    id: 'test',
    brand: 'Test',
    name: 'Test Shoe',
    purpose: 'casual',
    fit: 'medium',
    last: 'medium',
    fitAdjustment: 0,
    sizeChart: grid(),
    ...overrides
  }
}

function profile(overrides: Partial<ScoringProfile> = {}): ScoringProfile {
  return { footLengthMm: 250, fullness: 'medium', purpose: 'casual', ...overrides }
}

describe('scoreModel', () => {
  it('точное попадание: размер в наличии, score максимальный, verdict perfect', () => {
    // L + allowance = 250 + 10 = 260 → ровно US8.
    const result = scoreModel(profile(), shoe())
    expect(result.recommendedUs).toBe(8)
    expect(result.score).toBe(100)
    expect(result.verdict).toBe('perfect')
  })

  it('граничное «между размерами»: S_length = 0.5, verdict good', () => {
    // L + 10 = 265 — ровно между 260 и 270, при равной дистанции берём меньший (US8).
    const result = scoreModel(profile({ footLengthMm: 255 }), shoe())
    expect(result.recommendedUs).toBe(8)
    // 100 * (0.45*0.5 + 0.25 + 0.15 + 0.15) = 77.5 → 78
    expect(result.score).toBe(78)
    expect(result.verdict).toBe('good')
  })

  it('большое несовпадение длины: S_length = 0, verdict poor', () => {
    // Стопа 200 мм, минимальный размер сетки рассчитан на 240 мм.
    const result = scoreModel(profile({ footLengthMm: 200 }), shoe())
    expect(result.score).toBe(55) // 100 * (0.25 + 0.15 + 0.15)
    expect(result.verdict).toBe('poor')
  })

  it('широкая стопа + узкая модель/колодка: штраф по S_width и S_last', () => {
    const narrow = scoreModel(
      profile({ fullness: 'wide' }),
      shoe({ fit: 'narrow', last: 'narrow' })
    )
    const wide = scoreModel(
      profile({ fullness: 'wide' }),
      shoe({ fit: 'wide', last: 'wide' })
    )
    expect(narrow.score).toBe(60) // 100 * (0.45 + 0.15) — только длина и назначение
    expect(wide.score).toBe(100)
    expect(narrow.verdict).toBe('poor')
  })

  it('trail-модель при цели running хуже running-модели', () => {
    const base = { fit: 'medium' as const, last: 'medium' as const, fitAdjustment: 0, sizeChart: grid() }
    const trail = scoreModel(profile({ purpose: 'running' }), shoe({ ...base, purpose: 'trail' }))
    const running = scoreModel(profile({ purpose: 'running' }), shoe({ ...base, purpose: 'running' }))
    // Пересечение running ↔ trail даёт S_purpose = 0.5 вместо 1.
    expect(running.score).toBe(100)
    expect(trail.score).toBe(93) // 100 * (1 - 0.15 * 0.5) = 92.5 → 93
    expect(trail.score).toBeLessThan(running.score)
  })

  it('fitAdjustment −1 (Converse) выбирает меньший размер', () => {
    // L + 10 = 260 → базовый US8, поправка −1 → US7.
    const converse = shoe({ fitAdjustment: -1, sizeChart: grid(7, 250, 6) })
    const result = scoreModel(profile(), converse)
    expect(result.recommendedUs).toBe(7)
    expect(result.recommendedEu).toBe(converse.sizeChart[0].eu)
  })

  it('полуразмеры в сетке: выбирается ближайший имеющийся размер', () => {
    // Сетка с полуразмерами 8.5 и 9.5; L + 10 = 273 → базовый US8.5 (270 мм).
    const halfGrid: SizeEntry[] = [
      { us: 8, uk: 7, eu: '41', footLengthMm: 260 },
      { us: 8.5, uk: 7.5, eu: '42', footLengthMm: 270 },
      { us: 9.5, uk: 8.5, eu: '43', footLengthMm: 280 }
    ]
    const result = scoreModel(profile({ footLengthMm: 263 }), shoe({ sizeChart: halfGrid }))
    // 273 − 270 = 3 мм отклонения → S_length = 0.7 → score = 100 * (0.315 + 0.55) = 87.
    expect(result.recommendedUs).toBe(8.5)
    expect(result.score).toBe(87)
    expect(result.verdict).toBe('perfect')
  })

  it('пустая размерная сетка: score 0, без падений', () => {
    const result = scoreModel(profile(), shoe({ sizeChart: [] }))
    expect(result.score).toBe(0)
    expect(result.verdict).toBe('poor')
  })
})
