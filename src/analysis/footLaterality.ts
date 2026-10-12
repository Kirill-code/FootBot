// Автоопределение левой/правой стопы по контуру top-вида.
// Чистая функция — без OpenCV/DOM, покрыта unit-тестами.
//
// Геометрия: у стопы большой палец на внутренней (медиальной) стороне.
// В toe-third контура (треть у пальцев) внутренняя половина массивнее:
// плавное утолщение у основания большого пальца и более прямой внутренний
// край. Сканирующие линии дают профили ширины левой/правой половин;
// более массивная сторона = внутренняя. Второй сигнал — смещение крайней
// точки пальцев (мыска) от оси стопы: мысок «завёрнут» к внутренней стороне.
//
// Маппинг (пальцы «вверх» кадра, камера над стопой): внутренняя сторона
// справа → левая стопа, слева → правая. При пальцах «вниз» (к камере) —
// зеркально.

import type { FootContourPoint } from './measureFoot'

export type FootLaterality = 'left' | 'right'

export interface LateralityResult {
  side: FootLaterality
  /** Выраженность асимметрии, 0..1. */
  confidence: number
  /** Внутренняя (большой палец) сторона в координатах кадра. */
  innerSide: 'left' | 'right'
}

/** Минимальная заметная асимметрия: ниже — контур считаем симметричным. */
const MIN_ASYMMETRY = 0.06
/** Асимметрия, при которой доверие максимально (confidence → 1). */
const FULL_ASYMMETRY = 0.3

interface ScanRow {
  y: number
  left: number
  right: number
}

/** Точки пересечения горизонтали y с полигоном → [minX, maxX] или null. */
function scanRow(pts: FootContourPoint[], y: number): { left: number; right: number } | null {
  const xs: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const y1 = a.y
    const y2 = b.y
    if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) {
      xs.push(a.x + ((y - y1) / (y2 - y1)) * (b.x - a.x))
    }
  }
  if (xs.length < 2) return null
  let left = Infinity
  let right = -Infinity
  for (const x of xs) {
    if (x < left) left = x
    if (x > right) right = x
  }
  return { left, right }
}

/**
 * Определяет левую/правую стопу по top-контуру.
 * @param contour контур стопы (замкнутый, заметно вытянутый вертикально)
 * @param toesUp true — пальцы к верхней границе кадра (по умолчанию)
 * @returns null — стопа симметрична / контур неподходящий
 */
export function detectLaterality(
  contour: FootContourPoint[],
  toesUp = true
): LateralityResult | null {
  if (contour.length < 8) return null
  let yMin = Infinity
  let yMax = -Infinity
  for (const p of contour) {
    if (p.y < yMin) yMin = p.y
    if (p.y > yMax) yMax = p.y
  }
  const len = yMax - yMin
  if (len < 20) return null

  // Сканирующие линии по всей длине.
  const rows: ScanRow[] = []
  const y0 = Math.ceil(yMin)
  const y1 = Math.floor(yMax)
  for (let y = y0; y <= y1; y++) {
    const r = scanRow(contour, y + 0.5)
    if (r && r.right - r.left > 1) rows.push({ y, left: r.left, right: r.right })
  }
  if (rows.length < 8) return null

  // Ось стопы — медиана мидпоинтов (устойчива к выбросам пальцев).
  const mids = rows.map((r) => (r.left + r.right) / 2).sort((a, b) => a - b)
  const axis = mids[mids.length >> 1]

  // Toe-third: треть контура у пальцев.
  const toeEnd = yMin + len * 0.35
  let leftMass = 0
  let rightMass = 0
  let tipSum = 0
  let tipN = 0
  let halfSum = 0
  for (const r of rows) {
    const half = (r.right - r.left) / 2
    halfSum += half
    if (r.y <= toeEnd) {
      leftMass += Math.max(0, axis - r.left)
      rightMass += Math.max(0, r.right - axis)
    }
    if (r.y <= yMin + len * 0.12) {
      tipSum += (r.left + r.right) / 2 - axis
      tipN++
    }
  }
  const mass = leftMass + rightMass
  if (mass <= 0 || tipN === 0) return null
  const meanHalf = halfSum / rows.length
  if (meanHalf <= 0) return null

  // Сигнал массы: >0 — внутренняя сторона справа.
  const massSignal = (rightMass - leftMass) / mass
  // Сигнал мыска: >0 — крайняя точка пальцев правее оси.
  const tipSignal = Math.max(-1, Math.min(1, (tipSum / tipN / meanHalf) * 2))
  const combined = 0.7 * massSignal + 0.3 * tipSignal

  if (Math.abs(combined) < MIN_ASYMMETRY) return null
  const innerRight = combined > 0
  const confidence = Math.min(1, Math.abs(combined) / FULL_ASYMMETRY)
  // Пальцы вверх: внутренняя справа → левая стопа. Пальцы вниз — зеркально.
  const side: FootLaterality = innerRight === toesUp ? 'left' : 'right'
  return { side, confidence, innerSide: innerRight ? 'right' : 'left' }
}
