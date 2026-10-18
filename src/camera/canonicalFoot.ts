// Канонический силуэт стопы для live-оверлея: вместо сырого дёргающегося
// контура маски рисуем стабильную форму (шаблон), подогнанную под детект,
// а поверх — дельту: зоны, где реальная маска выходит за канон.
// Чистые функции — unit-тесты без DOM/OpenCV.

export interface CanonPoint {
  x: number
  y: number
}

/** Трансформация канона в координаты маски. Канон: стопа вдоль оси Y,
 * пальцы в -Y (вверх), длина 2 (y ∈ [-1, 1]). scale = полудлина в px. */
export interface CanonicalTransform {
  cx: number
  cy: number
  /** Полудлина канона в пикселях (canon y=±1 → cy±scale). */
  scale: number
  /** Угол поворота канона (радианы; 0 — пальцы строго вверх). */
  angle: number
  /** Качество фита, 0..1 (совпадение пропорций маски и канона). */
  quality: number
}

/** Полуширина канона top (длина 2 → ширина 2/2.6). */
const TOP_HALF_W = 1 / 2.6

/** Профиль полуширины top-канона по Y (пальцы -1 → пятка 1). */
const TOP_PROFILE: Array<[number, number]> = [
  [-1.0, 0.1],
  [-0.92, 0.3],
  [-0.8, 0.52],
  [-0.62, 0.75],
  [-0.35, 0.92],
  [0.0, 1.0],
  [0.3, 0.82],
  [0.6, 0.62],
  [0.8, 0.55],
  [0.95, 0.45],
  [1.0, 0.28]
]

function profHalfW(y: number, prof: Array<[number, number]>): number {
  if (y <= prof[0][0]) return prof[0][1]
  for (let i = 1; i < prof.length; i++) {
    if (y <= prof[i][0]) {
      const [y0, w0] = prof[i - 1]
      const [y1, w1] = prof[i]
      return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0)
    }
  }
  return prof[prof.length - 1][1]
}

/** Канон top: контур анфас (пальцы вверх), ~42 точки. */
export const CANON_TOP: CanonPoint[] = (() => {
  const right: CanonPoint[] = []
  const left: CanonPoint[] = []
  const N = 16
  for (let i = 0; i <= N; i++) {
    const y = -1 + (2 * i) / N
    const hw = profHalfW(y, TOP_PROFILE) * TOP_HALF_W
    right.push({ x: hw, y })
    left.push({ x: -hw, y })
  }
  // Замыкаем низ пятки дугой (последние точки сходятся).
  return [...right, ...left.reverse()]
})()

/** Канон side: профиль (пятка сзади-слева при пальцах вверх, носок справа).
 * Ось Y — длина стопы, X — толщина (плюс = к носку). Подошва внизу (y≈1). */
export const CANON_SIDE: CanonPoint[] = (() => {
  // Обход по часовой: мысок → верх мыска → свод → задник → подошва → низ мыска.
  return [
    { x: 0.22, y: -1.0 }, // мысок (носок)
    { x: 0.3, y: -0.9 }, // верх мыска
    { x: 0.26, y: -0.72 }, // носок сужается
    { x: 0.12, y: -0.35 }, // свод впереди
    { x: -0.02, y: -0.05 }, // высшая точка свода (подъём)
    { x: -0.14, y: 0.25 }, // свод к щиколотке
    { x: -0.24, y: 0.55 }, // задник пятки
    { x: -0.26, y: 0.8 }, // пятка
    { x: -0.2, y: 0.97 }, // зад подошвы
    { x: 0.0, y: 1.0 }, // подошва центр
    { x: 0.2, y: 0.98 }, // подошва к носку
    { x: 0.3, y: 0.9 } // низ мыска
  ]
})()

/** Канон по ракурсу. */
export function canonForView(view: 'top' | 'side'): CanonPoint[] {
  return view === 'top' ? CANON_TOP : CANON_SIDE
}

/** Аспект (ширина/длина) канона — для оценки качества фита. */
function canonAspect(view: 'top' | 'side'): number {
  return view === 'top' ? TOP_HALF_W * 2 * 0.95 : 0.55
}

/** Point-in-polygon (even-odd). */
export function pointInPolygon(px: number, py: number, poly: CanonPoint[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Фиттинг канона по бинарной маске (стопа = крупнейшая компонента).
 * Главная ось — PCA по пикселям маски; пальцы — конец, дальний от центра масс.
 * Масштаб — по экстенту вдоль главной оси.
 */
export function fitCanonical(
  bin: Uint8Array,
  w: number,
  h: number,
  view: 'top' | 'side'
): CanonicalTransform | null {
  let n = 0
  let mx = 0
  let my = 0
  const step = 2
  for (let y = 0; y < h; y += step) {
    const row = y * w
    for (let x = 0; x < w; x += step) {
      if (bin[row + x]) {
        mx += x
        my += y
        n++
      }
    }
  }
  if (n < 40) return null

  mx /= n
  my /= n
  let cxx = 0
  let cxy = 0
  let cyy = 0
  for (let y = 0; y < h; y += step) {
    const row = y * w
    for (let x = 0; x < w; x += step) {
      if (bin[row + x]) {
        const dx = x - mx
        const dy = y - my
        cxx += dx * dx
        cxy += dx * dy
        cyy += dy * dy
      }
    }
  }
  // Главная ось 2x2 ковариации: угол половинного atan2.
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  // Экстенты вдоль/поперёк оси + сечения у концов (для направления пальцев).
  let tMin = Infinity
  let tMax = -Infinity
  let sMin = Infinity
  let sMax = -Infinity
  let sNearMin = 0
  let nNearMin = 0
  let sNearMax = 0
  let nNearMax = 0
  for (let y = 0; y < h; y += step) {
    const row = y * w
    for (let x = 0; x < w; x += step) {
      if (!bin[row + x]) continue
      const dx = x - mx
      const dy = y - my
      const t = dx * cos + dy * sin
      const s = -dx * sin + dy * cos
      if (t < tMin) tMin = t
      if (t > tMax) tMax = t
      if (s < sMin) sMin = s
      if (s > sMax) sMax = s
    }
  }
  const length = tMax - tMin
  const width = sMax - sMin
  if (length < 20) return null
  // Пальцы — У́ЗКИЙ конец (мысок тоньше пятки; у «ноги+стопы» голень тяжелее).
  // Средний |s| среди пикселей крайних 10% длины у каждого конца — у самого
  // края мысок (профиль 0.1) заметно уже пятки (0.28), на 25% разница
  // стирается (пятка к низу тоже сужается).
  const tNearMin = tMin + length * 0.1
  const tNearMax = tMax - length * 0.1
  for (let y = 0; y < h; y += step) {
    const row = y * w
    for (let x = 0; x < w; x += step) {
      if (!bin[row + x]) continue
      const dx = x - mx
      const dy = y - my
      const t = dx * cos + dy * sin
      const s = Math.abs(-dx * sin + dy * cos)
      if (t < tNearMin) { sNearMin += s; nNearMin++ }
      else if (t > tNearMax) { sNearMax += s; nNearMax++ }
    }
  }
  const meanSNearMin = nNearMin ? sNearMin / nNearMin : 0
  const meanSNearMax = nNearMax ? sNearMax / nNearMax : 0
  const toesAtMax = meanSNearMax < meanSNearMin
  // Канон: пальцы в -Y. R(angle)·(0,-1) = (sin, -cos) — направление на пальцы.
  const toesDx = toesAtMax ? cos : -cos
  const toesDy = toesAtMax ? sin : -sin
  const angle = Math.atan2(toesDx, -toesDy)
  const scale = length / 2
  const aspect = width / length
  const canonA = canonAspect(view)
  const quality = Math.max(0, Math.min(1, 1 - Math.abs(aspect - canonA) / canonA))
  return { cx: mx, cy: my, scale, angle, quality }
}

/** Поворот/масштаб/перенос канона в мировые координаты маски.
 * world = (cx,cy) + scale · R(angle)·p — при angle=0 пальцы (0,-1) идут вверх. */
export function transformCanon(canon: CanonPoint[], t: CanonicalTransform): CanonPoint[] {
  const cos = Math.cos(t.angle)
  const sin = Math.sin(t.angle)
  return canon.map((p) => ({
    x: t.cx + t.scale * (p.x * cos - p.y * sin),
    y: t.cy + t.scale * (p.x * sin + p.y * cos)
  }))
}

/** Lerp-трансформация (сглаживание между кадрами). */
export function lerpTransform(
  prev: CanonicalTransform,
  next: CanonicalTransform,
  k: number
): CanonicalTransform {
  // Углы по кругу: интерполируем через поворотную разность.
  let da = next.angle - prev.angle
  while (da > Math.PI) da -= 2 * Math.PI
  while (da < -Math.PI) da += 2 * Math.PI
  return {
    cx: prev.cx + (next.cx - prev.cx) * k,
    cy: prev.cy + (next.cy - prev.cy) * k,
    scale: prev.scale + (next.scale - prev.scale) * k,
    angle: prev.angle + da * k,
    quality: prev.quality + (next.quality - prev.quality) * k
  }
}

/**
 * Дельта-зоны: ячейки сетки step px, где маска есть, а канона нет.
 * Возвращает компактную сетку для отрисовки (1 — залить оранжевым).
 */
export interface DeltaGrid {
  x0: number
  y0: number
  step: number
  gw: number
  gh: number
  cells: Uint8Array
}

export function deltaMask(bin: Uint8Array, w: number, h: number, canon: CanonPoint[], step = 4): DeltaGrid | null {
  // Гард: гигантский полигон делает point-in-polygon по сетке квадратично
  // дорогим (cells × pts → миллионы) — пропускаем дельту, рисуется только канон.
  if (canon.length > 500) return null
  let x0 = w
  let y0 = h
  let x1 = 0
  let y1 = 0
  let any = false
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (bin[row + x]) {
        any = true
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (!any) return null
  const gw = Math.max(1, Math.ceil((x1 - x0 + 1) / step))
  const gh = Math.max(1, Math.ceil((y1 - y0 + 1) / step))
  const cells = new Uint8Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = x0 + gx * step + step / 2
      const py = y0 + gy * step + step / 2
      const cx = Math.min(w - 1, Math.round(px))
      const cy = Math.min(h - 1, Math.round(py))
      if (bin[cy * w + cx] && !pointInPolygon(px, py, canon)) cells[gy * gw + gx] = 1
    }
  }
  return { x0, y0, step, gw, gh, cells }
}

// --- Paper-фильтр (live): исключение листа/бумаги из person-маски ---
// Компонента, похожая на бумагу (светлая, ненасыщенная, крупная),
// выбрасывается — иначе канон фиттится на лист вместо стопы.

/** RGB → (S, V) быстро, 0..255. */
function satVal(r: number, g: number, b: number): [number, number] {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b
  const min = r < g ? (r < b ? r : b) : g < b ? g : b
  return [max === 0 ? 0 : Math.round(((max - min) / max) * 255), max]
}

/**
 * Выбрасывает paper-like компоненты бинарной маски.
 * Критерий: средняя V > 170 И средняя S < 70 И площадь > 2% кадра.
 * @param bin бинарная маска (модифицируется копия — исходник не трогаем)
 * @param rgba пиксели исходного кадра (RGBA), размер w×h — как у маски
 * @returns новая маска без paper-компонент
 */
export function filterPaperComponents(bin: Uint8Array, w: number, h: number, rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(bin)
  const total = w * h
  const labels = new Int32Array(total).fill(-1)
  const stack = new Int32Array(total)
  let nextLabel = 0
  const compArea: number[] = []
  const compSumS: number[] = []
  const compSumV: number[] = []

  for (let start = 0; start < total; start++) {
    if (!bin[start] || labels[start] >= 0) continue
    const label = nextLabel++
    compArea.push(0)
    compSumS.push(0)
    compSumV.push(0)
    let sp = 0
    stack[sp++] = start
    labels[start] = label
    while (sp > 0) {
      const p = stack[--sp]
      const px = p % w
      const py = (p / w) | 0
      compArea[label]++
      // HSV по каждому 2-му пикселю — достаточно для среднего, вдвое быстрее.
      if (((px + py) & 1) === 0) {
        const o = p * 4
        const [s, v] = satVal(rgba[o], rgba[o + 1], rgba[o + 2])
        compSumS[label] += s
        compSumV[label] += v
      }
      if (px > 0 && bin[p - 1] && labels[p - 1] < 0) { labels[p - 1] = label; stack[sp++] = p - 1 }
      if (px < w - 1 && bin[p + 1] && labels[p + 1] < 0) { labels[p + 1] = label; stack[sp++] = p + 1 }
      if (py > 0 && bin[p - w] && labels[p - w] < 0) { labels[p - w] = label; stack[sp++] = p - w }
      if (py < h - 1 && bin[p + w] && labels[p + w] < 0) { labels[p + w] = label; stack[sp++] = p + w }
    }
  }

  const minArea = total * 0.02
  const paper = new Set<number>()
  for (let c = 0; c < nextLabel; c++) {
    if (compArea[c] < minArea) continue
    const n = Math.max(1, Math.floor(compArea[c] / 2))
    const meanS = compSumS[c] / n
    const meanV = compSumV[c] / n
    if (meanV > 170 && meanS < 70) paper.add(c)
  }
  if (paper.size === 0) return out
  for (let p = 0; p < total; p++) {
    if (out[p] && paper.has(labels[p])) out[p] = 0
  }
  return out
}
