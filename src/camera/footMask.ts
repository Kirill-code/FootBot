// Бинарная маска стопы из RGBA-кадра без NN и без OpenCV — для live-цикла
// видоискателя (каждые ~400 мс на кропе ≤560px, главный поток, чистый JS).
//
// Принцип — вычитание фона по кольцу кропа, а не жёсткий цвет листа:
// кадр строится как «гайд-рамка + 12% запас», поэтому внешнее кольцо (8%)
// почти всегда заполнено фоном (лист А4, пол). По нему оцениваем медианный
// цвет фона и его разброс (p80 расстояний) — порог адаптивный:
//   fg = dist(pixel, bgMedian) > max(26, 3·p80)
// Поверх — исключение paper-like пикселей (V>150 & S<70): белый лист,
// снятый на тёмном полу, сам контрастен фону кольца и без этого фильтра
// стал бы «стопой».
//
// Итог по фонам:
//  - белый лист: bg=бумага, стопа контрастна — маска чистая;
//  - деревянный/однородный пол без листа: всё ≈ bg — маска пустая,
//    статус «стопа не найдена» (а не контур на весь кадр);
//  - стопа на однородном полу: отличается от медианы — выделяется.
//
// Тень от ноги на листе (тот же оттенок, ниже V) формально попадает в маску
// — допустимо для live-подсказки: финальный замер делает measureFoot (OpenCV).
// Полоса 4% у краёв кропа обнуляется: кольцо оценки фона не должно попадать
// в саму маску.

/** Пороги paper-классификации (совпадают по смыслу с filterPaperComponents). */
const PAPER_MAX_S = 70
const PAPER_MIN_V = 150

/** Внешнее кольцо кропа для оценки фона. */
const RING_FRAC = 0.08
/** Доля края кропа, обнуляемая в маске с каждой стороны. */
const BORDER_FRAC = 0.04
/** Минимальное цветовое расстояние «не фон» (RGB-евклидово). */
const MIN_DIST = 26
/** Шаг прореживания при сборе статистики кольца (скорость). */
const RING_STRIDE = 2

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
}

/**
 * Маска «стопа» по кадру: отличается от фона кольца и не является бумагой.
 * @param rgba пиксели кадра (RGBA), длина w*h*4
 * @returns бинарная маска w*h (1 — кандидат стопы, 0 — фон/бумага/края)
 */
export function footBinFromFrame(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  const rx = Math.max(1, Math.round(w * RING_FRAC))
  const ry = Math.max(1, Math.round(h * RING_FRAC))

  // 1. Статистика фона по кольцу: медианный цвет + p80 расстояний до него.
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let y = 0; y < h; y += RING_STRIDE) {
    const inRingY = y < ry || y >= h - ry
    for (let x = 0; x < w; x += RING_STRIDE) {
      if (!inRingY && x >= rx && x < w - rx) continue // внутренность — не кольцо
      const o = (y * w + x) * 4
      rs.push(rgba[o])
      gs.push(rgba[o + 1])
      bs.push(rgba[o + 2])
    }
  }
  if (rs.length < 16) return bin // кадр-крайность: маски нет
  rs.sort((a, b) => a - b)
  gs.sort((a, b) => a - b)
  bs.sort((a, b) => a - b)
  const mr = rs[rs.length >> 1]
  const mg = gs[gs.length >> 1]
  const mb = bs[bs.length >> 1]
  const dists: number[] = []
  for (let y = 0; y < h; y += RING_STRIDE) {
    const inRingY = y < ry || y >= h - ry
    for (let x = 0; x < w; x += RING_STRIDE) {
      if (!inRingY && x >= rx && x < w - rx) continue
      const o = (y * w + x) * 4
      const dr = rgba[o] - mr
      const dg = rgba[o + 1] - mg
      const db = rgba[o + 2] - mb
      dists.push(Math.sqrt(dr * dr + dg * dg + db * db))
    }
  }
  dists.sort((a, b) => a - b)
  const thr = Math.max(MIN_DIST, 3 * percentile(dists, 80))

  // 2. Маска: «не фон» и «не бумага», края обнулены.
  const bx = Math.round(w * BORDER_FRAC)
  const by = Math.round(h * BORDER_FRAC)
  const thr2 = thr * thr
  for (let y = 0; y < h; y++) {
    const inY = y >= by && y < h - by
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (!inY || x < bx || x >= w - bx) continue
      const o = (row + x) * 4
      const r = rgba[o]
      const g = rgba[o + 1]
      const b = rgba[o + 2]
      const dr = r - mr
      const dg = g - mg
      const db = b - mb
      if (dr * dr + dg * dg + db * db <= thr2) continue // фон
      const max = r > g ? (r > b ? r : b) : g > b ? g : b
      const min = r < g ? (r < b ? r : b) : g < b ? g : b
      const s = max === 0 ? 0 : ((max - min) / max) * 255
      if (s < PAPER_MAX_S && max > PAPER_MIN_V) continue // бумага
      bin[row + x] = 1
    }
  }
  return bin
}
