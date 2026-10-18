// Построение контура из бинарной маски без OpenCV: крупнейшая связная
// компонента → трассировка границы (Moore) → упрощение (Ramer–Douglas–
// Peucker) → сглаживание. Чистые функции — пригодны для unit-тестов.
// Источник маски — footMask.ts (цветовая «не бумага» на листе А4).
// measureFoot не использует этот модуль (у него свой контурный пайплайн
// на OpenCV — финальный замер по полному кадру).

import type { FootContourPoint } from '../analysis/measureFoot'

export interface MaskComponent {
  /** Бинарная маска крупнейшей компоненты (1 — принадлежит). */
  bin: Uint8Array
  area: number
  x: number
  y: number
  width: number
  height: number
}

/** Крупнейшая 4-связная компонента из бинарной маски (BFS-заливка). */
export function largestComponent(bin: Uint8Array, w: number, h: number): MaskComponent | null {
  const visited = new Uint8Array(w * h)
  let best: MaskComponent | null = null
  const stack = new Int32Array(w * h)

  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || visited[start]) continue
    let sp = 0
    stack[sp++] = start
    visited[start] = 1
    let area = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    while (sp > 0) {
      const p = stack[--sp]
      const px = p % w
      const py = (p / w) | 0
      area++
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      if (px > 0 && bin[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1 }
      if (px < w - 1 && bin[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1 }
      if (py > 0 && bin[p - w] && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w }
      if (py < h - 1 && bin[p + w] && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w }
    }
    if (area >= 32 && (!best || area > best.area)) {
      best = { bin: new Uint8Array(0), area, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
    }
  }
  if (!best) return null
  // Вторая проходка: выделяем пиксели крупнейшей компоненты в чистую маску.
  // Сид — первый fg-пиксель внутри bbox (угол bbox может быть фоновым).
  const comp = best as MaskComponent
  const out = new Uint8Array(w * h)
  let sp = 0
  let seed = -1
  outer: for (let y = comp.y; y <= comp.y + comp.height - 1; y++) {
    for (let x = comp.x; x <= comp.x + comp.width - 1; x++) {
      if (bin[y * w + x]) { seed = y * w + x; break outer }
    }
  }
  if (seed < 0) return null
  stack[sp++] = seed
  out[seed] = 1
  while (sp > 0) {
    const p = stack[--sp]
    const px = p % w
    const py = (p / w) | 0
    if (px > 0 && bin[p - 1] && !out[p - 1]) { out[p - 1] = 1; stack[sp++] = p - 1 }
    if (px < w - 1 && bin[p + 1] && !out[p + 1]) { out[p + 1] = 1; stack[sp++] = p + 1 }
    if (py > 0 && bin[p - w] && !out[p - w]) { out[p - w] = 1; stack[sp++] = p - w }
    if (py < h - 1 && bin[p + w] && !out[p + w]) { out[p + w] = 1; stack[sp++] = p + w }
  }
  comp.bin = out
  return comp
}

// Moore-окрестность по часовой стрелке, начиная с западного соседа.
const MOORE = [
  [-1, 0], [-1, 1], [0, 1], [1, 1],
  [1, 0], [1, -1], [0, -1], [-1, -1]
] as const

/** Начальная точка — самый верхний, из них самый левый. */
function findStart(bin: Uint8Array, w: number, h: number): number {
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) if (bin[row + x]) return row + x
  }
  return -1
}

/** Трассировка границы компоненты (Moore, критерий остановки Джейкоба). */
function traceBoundary(bin: Uint8Array, w: number, h: number): FootContourPoint[] {
  const start = findStart(bin, w, h)
  if (start < 0) return []
  const sx = start % w
  const sy = (start / w) | 0
  const pts: FootContourPoint[] = [{ x: sx, y: sy }]
  let px = sx
  let py = sy
  let bDir = 6 // backtrack = западный сосед стартовой точки (фон по построению)
  const maxIter = 8 * w * h
  for (let iter = 0; iter < maxIter; iter++) {
    let found = false
    for (let k = 1; k <= 8; k++) {
      const d = (bDir + k) % 8
      const nx = px + MOORE[d][0]
      const ny = py + MOORE[d][1]
      if (nx < 0 || nx >= w || ny < 0 || ny >= h || !bin[ny * w + nx]) continue
      // Новый backtrack — пиксель, с которого начали обход (фон).
      bDir = (d + 6) % 8
      px = nx
      py = ny
      pts.push({ x: nx, y: ny })
      found = true
      break
    }
    if (!found) break // одиночный пиксель
    if (px === sx && py === sy) return pts
  }
  return pts // превышен лимит — вернём что накопили
}

/** Выпуклая оболочка (Andrew monotone chain) — fallback для вырожденных. */
function convexHull(pts: FootContourPoint[]): FootContourPoint[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: FootContourPoint, a: FootContourPoint, b: FootContourPoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const build = (sign: number) => {
    const out: FootContourPoint[] = []
    for (const p of sorted) {
      while (out.length >= 2 && sign * cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...build(1), ...build(-1)]
}

/** Ramer–Douglas–Peucker для замкнутой ломаной. */
export function simplifyPolygon(pts: FootContourPoint[], epsilon: number): FootContourPoint[] {
  if (pts.length < 8) return pts.slice()
  // Самая дальняя от хорды start-end точка разбивает контур на две дуги.
  const s = pts[0]
  const e = pts[pts.length - 1]
  let split = 0
  let maxD = -1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLineDist(pts[i], s, e)
    if (d > maxD) { maxD = d; split = i }
  }
  const rdp = (from: number, to: number): FootContourPoint[] => {
    if (to - from < 2) return [pts[from]]
    const a = pts[from]
    const b = pts[to]
    let idx = from
    let dMax = -1
    for (let i = from + 1; i < to; i++) {
      const d = pointLineDist(pts[i], a, b)
      if (d > dMax) { dMax = d; idx = i }
    }
    if (dMax > epsilon) {
      return [...rdp(from, idx), ...rdp(idx, to)]
    }
    return [pts[from]]
  }
  // pts[0] === pts[last] (замкнутый контур) — последняя точка не нужна.
  return [...rdp(0, split), ...rdp(split, pts.length - 1)]
}

function pointLineDist(p: FootContourPoint, a: FootContourPoint, b: FootContourPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Скользящее среднее по замкнутой ломаной (две итерации). */
export function smoothPolygon(pts: FootContourPoint[], iterations = 2): FootContourPoint[] {
  if (pts.length < 4) return pts
  let cur = pts
  for (let it = 0; it < iterations; it++) {
    const next: FootContourPoint[] = new Array(cur.length)
    for (let i = 0; i < cur.length; i++) {
      const p0 = cur[(i - 1 + cur.length) % cur.length]
      const p1 = cur[i]
      const p2 = cur[(i + 1) % cur.length]
      next[i] = { x: (p0.x + 2 * p1.x + p2.x) / 4, y: (p0.y + 2 * p1.y + p2.y) / 4 }
    }
    cur = next
  }
  return cur
}

/**
 * Контур крупнейшей компоненты бинарной маски: трассировка → упрощение →
 * сглаживание. null — нет компоненты ≥ 32 px. Для вырожденных трассировок
 * (превышен лимит итераций) возвращает выпуклую оболочку.
 */
export function maskToContour(bin: Uint8Array, w: number, h: number): FootContourPoint[] | null {
  const comp = largestComponent(bin, w, h)
  if (!comp) return null
  let pts = traceBoundary(comp.bin, w, h)
  if (pts.length < 8) {
    // Собираем пиксели компоненты и строим оболочку.
    const all: FootContourPoint[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (comp.bin[y * w + x]) all.push({ x, y })
    }
    pts = convexHull(all)
  }
  if (pts.length < 6) return null
  // Гигантский контур (нога+джинсы целиком — до 37k точек): обязательное
  // упрощение до бюджета ≤200. Без этого drawOverlay рисует 37k-точечный
  // path каждый кадр, а delta/laterality получают O(pts) × O(сетка/строки)
  // — минуты на кадр, «зависание». >500 после упрощения — контур невалиден.
  let eps = Math.max(2, Math.min(w, h) / 180)
  let simplified = simplifyPolygon(pts, eps)
  let guard = 0
  while (simplified.length > 200 && eps < 3 && guard++ < 8) {
    eps = Math.min(3, eps * 1.5)
    simplified = simplifyPolygon(pts, eps)
  }
  if (simplified.length > 500) return null
  return smoothPolygon(simplified.length >= 4 ? simplified : pts)
}
