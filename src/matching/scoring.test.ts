import { describe, expect, it } from 'vitest'
import { scoreModel } from './scoring'
import type { ScoringProfile } from './scoring'
import type { ShoeModel, SizeEntry } from '../catalog/types'

/** Стандартная сетка: шаг 10 мм, US8 = 260 мм. */
function grid(startUs = 6, startMm = 240, count = 8): SizeEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const us = startUs + i
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

/**
 * Профиль со средним подъёмом (88/250 = 0.352 → 'medium' = дефолтный
 * допуск модели) — чтобы S_volume не занижал оценку в «классических» кейсах.
 */
function profile(overrides: Partial<ScoringProfile> = {}): ScoringProfile {
  return { footLengthMm: 250, fullness: 'medium', purpose: 'casual', instepHeightMm: 88, ...overrides }
}

describe('scoreModel: длина и размер', () => {
  it('точное попадание: размер в наличии, score максимальный, verdict perfect', () => {
    // L + allowance = 250 + 10 = 260 → ровно US8.
    const result = scoreModel(profile(), shoe())
    expect(result.recommendedUs).toBe(8)
    expect(result.score).toBe(100)
    expect(result.verdict).toBe('perfect')
    expect(result.breakdown).toEqual({
      S_length: 1,
      S_width: 1,
      S_volume: 1,
      S_last: 1,
      S_purpose: 1
    })
  })

  it('граничное «между размерами»: S_length = 0.5, verdict good', () => {
    // L + 10 = 265 — ровно между 260 и 270, при равной дистанции берём меньший (US8).
    const result = scoreModel(profile({ footLengthMm: 255 }), shoe())
    expect(result.recommendedUs).toBe(8)
    expect(result.breakdown.S_length).toBe(0.5)
    // 100 * (0.40*0.5 + 0.20 + 0.15 + 0.10 + 0.15) = 80
    expect(result.score).toBe(80)
    expect(result.verdict).toBe('good')
  })

  it('большое несовпадение длины: S_length = 0, verdict poor', () => {
    // Стопа 200 мм, минимальный размер сетки рассчитан на 240 мм.
    // Подъём 70 мм: 70/200 = 0.35 → средний уровень, как у дефолтного допуска.
    const result = scoreModel(profile({ footLengthMm: 200, instepHeightMm: 70 }), shoe())
    expect(result.breakdown.S_length).toBe(0)
    expect(result.score).toBe(60) // 100 * (0.20 + 0.15 + 0.10 + 0.15)
    expect(result.verdict).toBe('poor')
  })

  it('fitAdjustment −1 (Converse) выбирает меньший размер', () => {
    // L + 10 = 260 → базовый US8, поправка −1 → US7.
    const converse = shoe({ fitAdjustment: -1, sizeChart: grid(7, 250, 6) })
    const result = scoreModel(profile(), converse)
    expect(result.recommendedUs).toBe(7)
    expect(result.recommendedEu).toBe(converse.sizeChart[0].eu)
  })

  it('полуразмеры в сетке: выбирается ближайший имеющийся размер', () => {
    // Сетка с полуразмерами; L + 10 = 273 → базовый US8.5 (270 мм).
    const halfGrid: SizeEntry[] = [
      { us: 8, uk: 7, eu: '41', footLengthMm: 260 },
      { us: 8.5, uk: 7.5, eu: '42', footLengthMm: 270 },
      { us: 9.5, uk: 8.5, eu: '43', footLengthMm: 280 }
    ]
    const result = scoreModel(profile({ footLengthMm: 263 }), shoe({ sizeChart: halfGrid }))
    // 273 − 270 = 3 мм отклонения → S_length = 0.7 → score = 100 * (0.28 + 0.60) = 88.
    expect(result.recommendedUs).toBe(8.5)
    expect(result.score).toBe(88)
    expect(result.verdict).toBe('perfect')
  })

  it('пустая размерная сетка: score 0, без падений', () => {
    const result = scoreModel(profile(), shoe({ sizeChart: [] }))
    expect(result.score).toBe(0)
    expect(result.verdict).toBe('poor')
    expect(result.notes.length).toBeGreaterThan(0)
  })
})

describe('scoreModel: полнота и колодка', () => {
  it('широкая стопа + узкая модель/колодка: штраф по S_width и S_last', () => {
    const narrow = scoreModel(
      profile({ fullness: 'wide' }),
      shoe({ fit: 'narrow', last: 'narrow' })
    )
    const wide = scoreModel(
      profile({ fullness: 'wide' }),
      shoe({ fit: 'wide', last: 'wide' })
    )
    expect(narrow.breakdown.S_width).toBe(0)
    expect(narrow.breakdown.S_last).toBe(0)
    expect(narrow.score).toBe(70) // 100 * (0.40 + 0.15 объём + 0.15 назначение)
    expect(wide.score).toBe(100)
    expect(narrow.verdict).toBe('good') // 70 — нижняя граница good
  })

  it('widthRatio > 0.40 автоматически трактуется как широкая стопа', () => {
    // Заявлена средняя полнота, но соотношение ширины к длине 0.41.
    const wideFoot = profile({ fullness: 'medium', widthRatio: 0.41 })
    const narrowShoe = scoreModel(wideFoot, shoe({ fit: 'narrow', last: 'narrow' }))
    const wideShoe = scoreModel(wideFoot, shoe({ fit: 'wide', last: 'wide' }))
    expect(narrowShoe.breakdown.S_width).toBe(0)
    expect(wideShoe.breakdown.S_width).toBe(1)
    expect(wideShoe.score).toBeGreaterThan(narrowShoe.score)
    // Пояснение про уточнённую полноту попадает в notes.
    expect(wideShoe.notes.some((n) => n.includes('ширины к длине'))).toBe(true)
  })

  it('widthRatio < 0.36 трактуется как узкая стопа (ballWidthMm как источник)', () => {
    // ballWidthMm 90 / длина 250 = 0.36 — ровно порог средней; 89 → узкая.
    const foot = profile({ fullness: 'medium', ballWidthMm: 89 })
    const result = scoreModel(foot, shoe({ fit: 'narrow', last: 'narrow' }))
    expect(result.breakdown.S_width).toBe(1)
  })
})

describe('scoreModel: подъём (S_volume)', () => {
  it('высокий подъём + модель с low заметно хуже, чем с high', () => {
    // 95/250 = 0.38 > 0.36 → высокий подъём.
    const highInstep = profile({ instepHeightMm: 95 })
    const lowTol = scoreModel(highInstep, shoe({ instepTolerance: 'low' }))
    const highTol = scoreModel(highInstep, shoe({ instepTolerance: 'high' }))
    expect(lowTol.breakdown.S_volume).toBe(0)
    expect(highTol.breakdown.S_volume).toBe(1)
    expect(lowTol.score).toBe(85) // 100 * (1 - 0.15)
    expect(highTol.score).toBe(100)
    expect(lowTol.score).toBeLessThan(highTol.score)
    expect(lowTol.notes.some((n) => n.includes('Высокий подъём'))).toBe(true)
  })

  it('средний подъём против low-допуска: соседний уровень → 0.5', () => {
    const result = scoreModel(profile(), shoe({ instepTolerance: 'low' }))
    expect(result.breakdown.S_volume).toBe(0.5)
    expect(result.score).toBe(93) // 100 * (1 - 0.15*0.5) = 92.5 → 93
  })

  it('без instepHeightMm S_volume нейтрален (0.5)', () => {
    const p = profile({ instepHeightMm: undefined })
    const result = scoreModel(p, shoe())
    expect(result.breakdown.S_volume).toBe(0.5)
    // Ровно на 0.15*0.5 веса ниже полного совпадения.
    expect(result.score).toBe(93)
  })

  it('низкий подъём вписывается в любой допуск', () => {
    const lowInstep = profile({ instepHeightMm: 60 }) // 60/250 = 0.24 < 0.28
    for (const tol of ['low', 'medium', 'high'] as const) {
      expect(scoreModel(lowInstep, shoe({ instepTolerance: tol })).breakdown.S_volume).toBe(1)
    }
  })
})

describe('scoreModel: назначение и notes', () => {
  it('trail-модель при цели running хуже running-модели', () => {
    const base = { fit: 'medium' as const, last: 'medium' as const, fitAdjustment: 0, sizeChart: grid() }
    const trail = scoreModel(profile({ purpose: 'running' }), shoe({ ...base, purpose: 'trail' }))
    const running = scoreModel(profile({ purpose: 'running' }), shoe({ ...base, purpose: 'running' }))
    // Пересечение running ↔ trail даёт S_purpose = 0.5 вместо 1.
    expect(running.score).toBe(100)
    expect(trail.score).toBe(93) // 100 * (1 - 0.15 * 0.5) = 92.5 → 93
    expect(trail.score).toBeLessThan(running.score)
  })

  it('notes непустые для граничных случаев', () => {
    const between = scoreModel(profile({ footLengthMm: 255 }), shoe())
    expect(between.notes.some((n) => n.includes('Между размерами'))).toBe(true)

    const withAdjustment = scoreModel(profile(), shoe({ fitAdjustment: -0.5 }))
    expect(withAdjustment.notes.some((n) => n.includes('большемерит'))).toBe(true)

    const farAway = scoreModel(profile({ footLengthMm: 200 }), shoe())
    expect(farAway.notes.some((n) => n.includes('По длине'))).toBe(true)
  })
})
