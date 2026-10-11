// Модель стопы из замеров по трём ракурсам (top / side / front).
//
// Пороги volumeHint — по здравому смыслу из анатомических типичных значений:
//  - instep/length у взрослых ~0.28–0.35: ниже 0.26 — низкий подъём,
//    выше 0.36 — высокий;
//  - width/length ~0.38–0.45: ниже 0.38 — узкая, выше 0.45 — широкая.
// Оценка объёма — сумма баллов по двум признакам (0=low,1=medium,2=high):
// 0–1 → 'low', 2–3 → 'medium', 4 → 'high'. Если данных хватает только
// на один признак — объём оценивается по нему (low→low, medium→medium,
// high→high).

import type { FootMeasurement } from './measureFoot'

export type VolumeHint = 'low' | 'medium' | 'high'

/** Итоговая модель стопы (все поля nullable — ракурсы можно пропускать). */
export interface FootModel {
  /** Длина стопы, мм (из top; иначе кросс-проверка из side/front). */
  lengthMm: number | null
  /** Ширина стопы, мм (ракурс top). */
  widthMm: number | null
  /** Высота подъёма, мм (ракурс side). */
  instepHeightMm: number | null
  /** Ширина переднего отдела, мм (ракурс front). */
  ballWidthMm: number | null
  /** Отношение ширины к длине (null без пары значений). */
  widthRatio: number | null
  /** Оценка объёма стопы. */
  volumeHint: VolumeHint | null
  /** Расхождение длины side vs top больше 15 мм — данные ракурсов противоречат. */
  inconsistent: boolean
}

export interface FootModelInput {
  top?: FootMeasurement | null
  side?: FootMeasurement | null
  front?: FootMeasurement | null
}

/** Допуск согласованности длины между ракурсами, мм. */
export const LENGTH_INCONSISTENCY_MM = 15

function grade(value: number, lowBelow: number, highAbove: number): 0 | 1 | 2 {
  if (value < lowBelow) return 0
  if (value > highAbove) return 2
  return 1
}

export function buildFootModel(input: FootModelInput): FootModel {
  const top = input.top ?? null
  const side = input.side ?? null
  const front = input.front ?? null

  // Длина: приоритет top, иначе любой другой ракурс.
  const lengthMm = top?.lengthMm ?? side?.lengthMm ?? front?.lengthMm ?? null

  // Кросс-валидация: расхождение длин ракурсов.
  const lengths = [top?.lengthMm, side?.lengthMm, front?.lengthMm].filter(
    (v): v is number => typeof v === 'number'
  )
  const inconsistent =
    lengths.length >= 2 && Math.max(...lengths) - Math.min(...lengths) > LENGTH_INCONSISTENCY_MM

  const widthMm = top?.widthMm ?? null
  const instepHeightMm = side?.instepHeightMm ?? null
  const ballWidthMm = front?.ballWidthMm ?? null

  const widthRatio =
    widthMm !== null && lengthMm !== null && lengthMm > 0
      ? Math.round((widthMm / lengthMm) * 100) / 100
      : null

  // Объём: instep/length и width/length.
  const scores: number[] = []
  if (instepHeightMm !== null && lengthMm !== null && lengthMm > 0) {
    scores.push(grade(instepHeightMm / lengthMm, 0.26, 0.36))
  }
  if (widthRatio !== null) {
    scores.push(grade(widthRatio, 0.38, 0.45))
  }
  let volumeHint: VolumeHint | null = null
  if (scores.length === 1) {
    volumeHint = scores[0] === 0 ? 'low' : scores[0] === 2 ? 'high' : 'medium'
  } else if (scores.length === 2) {
    const sum = scores[0] + scores[1]
    volumeHint = sum <= 1 ? 'low' : sum >= 4 ? 'high' : 'medium'
  }

  return { lengthMm, widthMm, instepHeightMm, ballWidthMm, widthRatio, volumeHint, inconsistent }
}
