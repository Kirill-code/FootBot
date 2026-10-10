// Измерение стопы по фото с калибровкой по известному объекту (OpenCV.js).
//
// Пайплайн:
//  1. Поиск эталона: Canny → findContours → квад-кандидаты (approxPolyDP
//     с несколькими ε, fallback — minAreaRect). Эталоны: лист А4 (210 мм,
//     ratio 1.414), А5 (148 мм, 1.414), банковская карта (54 мм, 1.586).
//     Допуск по соотношению сторон ±0.25 (перспектива). Масштаб:
//     mmPerPx = (короткая сторона, px) / (мм эталона).
//  2. Сегментация стопы: Otsu (обе полярности) + morphologyEx. Если контур
//     сомнительный — fallback: grabCut с rect-инициализацией вокруг кандидата.
//  3. Длина — максимальное попарное расстояние по convex hull,
//     ширина — малая сторона minAreaRect.
//
// Если эталон не найден — стопу всё равно ищем и возвращаем
// referenceFound: false с нулевыми измерениями (для overlay в UI).
import { getOpenCv } from './opencvLoader'

/** Отладочный колбэк: получает промежуточные маски (только для тестового харнесса). */
export interface FootDebug {
  onMask(label: string, mat: unknown): void
  onInfo?(label: string, info: Record<string, unknown>): void
}

export interface FootContourPoint {
  x: number
  y: number
}

export type ReferenceKind = 'a4' | 'a5' | 'card'

export interface FootMeasurement {
  /** Длина стопы, мм (null, если нет эталона или стопы). */
  lengthMm: number | null
  /** Ширина стопы, мм (null, если нет эталона или стопы). */
  widthMm: number | null
  /** Контур стопы (упрощённый hull) в пикселях кадра. */
  footContour: FootContourPoint[]
  /** Найден ли эталон для калибровки масштаба. */
  referenceFound: boolean
  /** Найдена ли стопа. */
  footFound: boolean
  /** Тип найденного эталона. */
  referenceKind: ReferenceKind | null
}

interface ReferenceObject {
  kind: ReferenceKind
  /** Короткая сторона, мм. */
  shortMm: number
  /** Соотношение длинной к короткой стороне. */
  ratio: number
}

/** Мульти-эталон калибровки. */
const REFERENCES: ReferenceObject[] = [
  { kind: 'a4', shortMm: 210, ratio: Math.SQRT2 },
  { kind: 'a5', shortMm: 148, ratio: Math.SQRT2 },
  { kind: 'card', shortMm: 54, ratio: 85.6 / 54 }
]

/** Допуск по соотношению сторон (перспектива ~15–30°). */
const RATIO_TOLERANCE = 0.25
/** Кандидаты-эталоны: контуры крупнее 3% кадра. */
const REF_MIN_AREA_FRAC = 0.01
/** ε approxPolyDP как доля периметра — перебираем несколько. */
const POLY_EPS_FRACS = [0.01, 0.02, 0.035, 0.05]
/** Минимальная короткая сторона эталона, px (иначе масштаб неточен). */
const REF_MIN_SHORT_SIDE_PX = 40
/** Площадь стопы: 1–50% кадра (без эталона — тот же диапазон). */
const FOOT_MIN_AREA_FRAC = 0.01
const FOOT_MAX_AREA_FRAC = 0.35
/** Допустимое отношение длины стопы к ширине (по minAreaRect). */
const FOOT_ASPECT_MIN = 1.2
const FOOT_ASPECT_MAX = 6
/** Отступ от границы кадра при проверке касания. */
const BORDER_MARGIN_PX = 6

type Cv = ReturnType<typeof getOpenCv>
type CvMat = Cv['Mat']['prototype']

/** Все созданные Mat/MatVector/Scalar складываем сюда и удаляем в finally. */
class MatTracker {
  private mats: { delete(): void }[] = []
  track<T extends { delete(): void }>(m: T): T {
    this.mats.push(m)
    return m
  }
  dispose() {
    for (const m of this.mats) {
      try {
        m.delete()
      } catch {
        // ignore
      }
    }
    this.mats = []
  }
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

function contourPoints(mat: CvMat): FootContourPoint[] {
  const pts: FootContourPoint[] = []
  for (let i = 0; i < mat.rows; i++) {
    const p = mat.intPtr(i, 0) as ArrayLike<number>
    pts.push({ x: p[0], y: p[1] })
  }
  return pts
}

/** Длины четырёх сторон четырёхугольника, по возрастанию. */
function sortedSides(pts: FootContourPoint[]): number[] {
  return [0, 1, 2, 3]
    .map((j) => dist(pts[j].x, pts[j].y, pts[(j + 1) % 4].x, pts[(j + 1) % 4].y))
    .sort((a, b) => a - b)
}

interface Quad {
  pts: FootContourPoint[]
  areaPx: number
  /** true — из approxPolyDP, false — из minAreaRect (меньше доверия). */
  isPoly: boolean
  /** ROI исходного grayscale по bbox квада (для оценки яркости). */
  roi: CvMat | null
  /** Плотность эджей внутри квада: печатный текст (коробка) ≠ чистый лист. */
  internalEdgeDensity: number
}

interface ReferenceMatch {
  kind: ReferenceKind
  mmPerPx: number
  score: number
  /** Средняя яркость внутри квада. */
  brightness: number
  /** Квад эталона — исключаем эту зону при поиске стопы. */
  quad: Quad
}

/** Сопоставляет квад с ближайшим эталоном. null — не подошёл ни один. */
function matchReference(cv: Cv, quad: Quad, dbg?: FootDebug): ReferenceMatch | null {
  // Печатная поверхность (коробка с текстом, журнал) — не эталон.
  if (quad.internalEdgeDensity > 0.04) return null
  const sides = sortedSides(quad.pts)
  const shortPx = (sides[0] + sides[1]) / 2
  if (shortPx < REF_MIN_SHORT_SIDE_PX) return null
  const ratio = sides[3] / sides[0]
  if (sides[0] <= 0) return null

  // Средняя яркость внутри квада: бумага/карта — светлые.
  let brightness = 0
  if (quad.roi) {
    const mean = cv.mean(quad.roi) as unknown as ArrayLike<number>
    brightness = mean[0]
  }

  let best: ReferenceMatch | null = null
  for (const ref of REFERENCES) {
    const err = Math.abs(ratio - ref.ratio)
    if (err > RATIO_TOLERANCE) continue
    // Основной критерий — близость ratio; бонусы: точность poly, светлость.
    let score = RATIO_TOLERANCE - err + (quad.isPoly ? 0.05 : 0)
    if (brightness > 220) score += 0.1
    else if (brightness > 195) score += 0.03
    if (!best || score > best.score) {
      best = { kind: ref.kind, mmPerPx: ref.shortMm / shortPx, score, brightness, quad }
    }
  }
  dbg?.onInfo?.('ref_quad', {
    matched: best?.kind ?? null,
    ratio: Math.round(ratio * 100) / 100,
    brightness: Math.round(brightness),
    density: Math.round(quad.internalEdgeDensity * 1000) / 1000,
    isPoly: quad.isPoly,
    score: best ? Math.round(best.score * 1000) / 1000 : null
  })
  return best
}

/** Собирает квад-кандидатов из Canny-эджей. */
function collectQuads(cv: Cv, edges: CvMat, gray: CvMat, frameArea: number, t: MatTracker): Quad[] {
  // Лёгкий close — заделать микроразрывы краёв (фото шумные).
  const kernel = t.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)))
  const closed = t.track(new cv.Mat())
  cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel)

  const contours = t.track(new cv.MatVector())
  const hierarchy = t.track(new cv.Mat())
  cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

  const quads: Quad[] = []
  for (let i = 0; i < contours.size(); i++) {
    const cnt = t.track(contours.get(i))
    const area = cv.contourArea(cnt)
    if (area < frameArea * REF_MIN_AREA_FRAC) continue

    const peri = cv.arcLength(cnt, true)
    let quad: Quad | null = null

    // 1) approxPolyDP с растущим ε — ищем ровно 4 вершины.
    for (const epsFrac of POLY_EPS_FRACS) {
      const approx = t.track(new cv.Mat())
      cv.approxPolyDP(cnt, approx, epsFrac * peri, true)
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        quad = { pts: contourPoints(approx), areaPx: area, isPoly: true, roi: null, internalEdgeDensity: 0 }
        break
      }
    }

    // 2) Fallback: minAreaRect (грязные края реальной бумаги/карты).
    if (!quad) {
      const rect = cv.minAreaRect(cnt)
      const w = rect.size.width
      const h = rect.size.height
      if (w > 0 && h > 0) {
        const angle = (rect.angle * Math.PI) / 180
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const hw = w / 2
        const hh = h / 2
        quad = {
          pts: [
            { x: Math.round(rect.center.x - hw * cos + hh * sin), y: Math.round(rect.center.y - hw * sin - hh * cos) },
            { x: Math.round(rect.center.x + hw * cos + hh * sin), y: Math.round(rect.center.y + hw * sin - hh * cos) },
            { x: Math.round(rect.center.x + hw * cos - hh * sin), y: Math.round(rect.center.y + hw * sin + hh * cos) },
            { x: Math.round(rect.center.x - hw * cos - hh * sin), y: Math.round(rect.center.y - hw * sin + hh * cos) }
          ],
          areaPx: area,
          isPoly: false,
          roi: null,
          internalEdgeDensity: 0
        }
      }
    }

    if (quad) {
      // ROI grayscale по bbox квада — оценим яркость (бумага светлая).
      const xs = quad.pts.map((p) => p.x)
      const ys = quad.pts.map((p) => p.y)
      const rx = Math.max(0, Math.min(...xs))
      const ry = Math.max(0, Math.min(...ys))
      const rw = Math.min(gray.cols - rx, Math.max(...xs) - rx)
      const rh = Math.min(gray.rows - ry, Math.max(...ys) - ry)
      quad.roi = rw > 4 && rh > 4 ? t.track(gray.roi({ x: rx, y: ry, width: rw, height: rh })) : null
      if (rw > 4 && rh > 4) {
        const edgesRoi = t.track(edges.roi({ x: rx, y: ry, width: rw, height: rh }))
        quad.internalEdgeDensity = cv.countNonZero(edgesRoi) / (rw * rh)
      } else {
        quad.internalEdgeDensity = 1
      }
      quads.push(quad)
    }
  }
  return quads
}

/** Ищет эталон калибровки. null — не найден. */
function findReference(cv: Cv, edges: CvMat, gray: CvMat, frameArea: number, t: MatTracker, dbg?: FootDebug): ReferenceMatch | null {
  const quads = collectQuads(cv, edges, gray, frameArea, t)
  let best: ReferenceMatch | null = null
  for (const quad of quads) {
    const m = matchReference(cv, quad, dbg)
    if (m && (!best || m.score > best.score)) best = m
  }
  // Слабый скор при умеренной яркости — сомнительный объект (коробка, рама),
  // а не бумага: лучше честный «эталон не найден», чем ложная калибровка.
  if (best && best.score < 0.3 && best.brightness < 225) return null
  return best
}

/** Прямоугольник квада эталона (с небольшим запасом). */
function quadBounds(quad: Quad): { x: number; y: number; w: number; h: number } {
  const xs = quad.pts.map((p) => p.x)
  const ys = quad.pts.map((p) => p.y)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
}

interface FootCandidate {
  contour: CvMat
  /** Маска компонента (255 — объект), размер кадра. */
  mask: CvMat
  /** Полная (до эрозии) маска прохода — для морфологической реконструкции. */
  fullMask?: CvMat
  area: number
  /** Доля точек контура, касающихся границ кадра (0 — не касается). */
  borderTouch: number
  /** Оценка «похожести на стопу» — чем выше, тем лучше. */
  rank: number
}

/** Прямоугольник квада эталона с запасом, или null. */
let activeRefBounds: { x: number; y: number; w: number; h: number } | null = null

/** Пересекается ли контур с зоной эталона (bbox-перекрытие или центроид внутри). */
function overlapsReference(cv: Cv, cnt: CvMat, bounds: { x: number; y: number; w: number; h: number }): boolean {
  const m = cv.moments(cnt)
  if (m.m00 > 0) {
    const cx = m.m10 / m.m00
    const cy = m.m01 / m.m00
    if (cx >= bounds.x - 20 && cx <= bounds.x + bounds.w + 20 && cy >= bounds.y - 20 && cy <= bounds.y + bounds.h + 20) {
      return true
    }
  }
  const box = cv.boundingRect(cnt)
  const overlapW = Math.min(box.x + box.width, bounds.x + bounds.w) - Math.max(box.x, bounds.x)
  const overlapH = Math.min(box.y + box.height, bounds.y + bounds.h) - Math.max(box.y, bounds.y)
  if (overlapW <= 0 || overlapH <= 0) return false
  const overlapArea = overlapW * overlapH
  return overlapArea > 0.3 * box.width * box.height
}

/** Доля точек контура в полосе у каждой границы кадра. */
function borderTouchFraction(cnt: CvMat, w: number, h: number): number {
  let touching = 0
  const total = cnt.rows
  for (let i = 0; i < total; i++) {
    const p = cnt.intPtr(i, 0) as ArrayLike<number>
    const x = p[0]
    const y = p[1]
    if (x <= BORDER_MARGIN_PX || x >= w - BORDER_MARGIN_PX || y <= BORDER_MARGIN_PX || y >= h - BORDER_MARGIN_PX) {
      touching++
    }
  }
  return total > 0 ? touching / total : 1
}

/** Проверяет, похож ли контур на стопу по площади, пропорциям и заполнению bbox. */
function looksLikeFoot(cv: Cv, cnt: CvMat, area: number, frameArea: number, frameH: number): boolean {
  if (area < frameArea * FOOT_MIN_AREA_FRAC || area > frameArea * FOOT_MAX_AREA_FRAC) return false
  const m = cv.moments(cnt)
  if (m.m00 <= 0) return false
  // Стопа не должна висеть в верхней части кадра (руки, стены, коробки).
  if (m.m01 / m.m00 < 0.4 * frameH) return false
  const rect = cv.minAreaRect(cnt)
  const long = Math.max(rect.size.width, rect.size.height)
  const short = Math.min(rect.size.width, rect.size.height)
  if (short <= 0) return false
  if (long / short < FOOT_ASPECT_MIN || long / short > FOOT_ASPECT_MAX) return false
  // Стопа округлая: заполняет bbox частично. Листы/коробки/карты — почти полностью.
  const box = cv.boundingRect(cnt)
  const extent = box.width * box.height > 0 ? area / (box.width * box.height) : 0
  return extent >= 0.15 && extent <= 0.88
}

/** Ожидаемая площадь стопы в px (если есть эталон), иначе null. */
let expectedFootAreaPx: number | null = null

/** Комплексная оценка кандидата: форма + касание границ + позиция + размер. */
function rankCandidate(cv: Cv, cnt: CvMat, area: number, touch: number, frameArea: number, frameH: number): number {
  let rank = 0
  if (looksLikeFoot(cv, cnt, area, frameArea, frameH)) rank += 2
  if (touch < 0.02) rank += 1
  else if (touch < 0.15) rank += 0.5
  const m = cv.moments(cnt)
  if (m.m00 > 0 && m.m01 / m.m00 > 0.55 * frameH) rank += 0.25 // стопы обычно в нижней части кадра
  // При наличии эталона: бонус за соответствие ожидаемому размеру стопы.
  if (expectedFootAreaPx && expectedFootAreaPx > 0) {
    const err = (area - expectedFootAreaPx) / expectedFootAreaPx
    rank += 1 / (1 + 6 * err * err)
  }
  return rank
}

/**
 * Тёмная маска через kmeans (k=3) по яркости.
 * Глобальный Оцу путается при трёх модах (носок/паркет/стена) — kmeans
 * разделяет «тёмный класс» устойчиво.
 */
function kmeansDarkMask(cv: Cv, gray: CvMat, t: MatTracker): CvMat | null {
  cv.setRNGSeed(42) // детерминизм между запусками
  const total = gray.rows * gray.cols
  const stride = Math.max(1, Math.floor(total / 50000))
  const samples: number[] = []
  for (let y = 0; y < gray.rows; y++) {
    for (let x = 0; x < gray.cols; x++) {
      if ((y * gray.cols + x) % stride === 0) samples.push(gray.ucharPtr(y, x)[0])
    }
  }
  if (samples.length < 100) return null
  // Своя реализация kmeans (k=3): cv.kmeans в wasm недетерминирован
  // из-за параллельной редукции — результаты плавали между запусками.
  const sorted = [...samples].sort((a, b) => a - b)
  let centers = [
    sorted[Math.floor(sorted.length * 0.1)],
    sorted[Math.floor(sorted.length * 0.5)],
    sorted[Math.floor(sorted.length * 0.9)]
  ]
  for (let iter = 0; iter < 30; iter++) {
    const sum = [0, 0, 0]
    const cnt = [0, 0, 0]
    for (const v of samples) {
      const d0 = (v - centers[0]) * (v - centers[0])
      const d1 = (v - centers[1]) * (v - centers[1])
      const d2 = (v - centers[2]) * (v - centers[2])
      if (d0 <= d1 && d0 <= d2) {
        sum[0] += v
        cnt[0]++
      } else if (d1 <= d2) {
        sum[1] += v
        cnt[1]++
      } else {
        sum[2] += v
        cnt[2]++
      }
    }
    const next = [0, 1, 2].map((k) => (cnt[k] > 0 ? sum[k] / cnt[k] : centers[k]))
    const shift = Math.abs(next[0] - centers[0]) + Math.abs(next[1] - centers[1]) + Math.abs(next[2] - centers[2])
    centers = next
    if (shift < 0.5) break
  }
  const c = [...centers].sort((a, b) => a - b)
  const t1 = (c[0] + c[1]) / 2
  if (!(t1 > 10 && t1 < 245)) return null
  const dark = t.track(new cv.Mat())
  cv.threshold(gray, dark, t1, 255, cv.THRESH_BINARY_INV)
  return dark
}
function collectFootCandidates(
  cv: Cv,
  binary: CvMat,
  srcW: number,
  srcH: number,
  frameArea: number,
  t: MatTracker,
  dbg?: FootDebug,
  allowSplit = true
): FootCandidate[] {
  const contours = t.track(new cv.MatVector())
  const hierarchy = t.track(new cv.Mat())
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

  const out: FootCandidate[] = []
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i)
    const area = cv.contourArea(cnt)
    if (area < frameArea * (FOOT_MIN_AREA_FRAC / 4)) {
      cnt.delete()
      continue
    }
    // При наличии эталона: отсекаем объекты, чей размер несовместим со стопой
    // (слипшаяся мебель, коробка, участки пола).
    if (expectedFootAreaPx && expectedFootAreaPx > 0 && (area < 0.45 * expectedFootAreaPx || area > 2.2 * expectedFootAreaPx)) {
      cnt.delete()
      continue
    }
    if (activeRefBounds && overlapsReference(cv, cnt, activeRefBounds)) {
      cnt.delete()
      continue
    }
    const touch = borderTouchFraction(cnt, srcW, srcH)
    const rank = rankCandidate(cv, cnt, area, touch, frameArea, srcH)
    const box = cv.boundingRect(cnt)
    dbg?.onInfo?.('candidate', {
      areaPct: Math.round((area / frameArea) * 1000) / 10,
      touch: Math.round(touch * 100) / 100,
      rank,
      bbox: [box.x, box.y, box.width, box.height]
    })
    const mask = t.track(cv.Mat.zeros(srcH, srcW, cv.CV_8UC1))
    cv.drawContours(mask, contours, i, new cv.Scalar(255), cv.FILLED)
    const cand: FootCandidate = { contour: cnt, mask, area, borderTouch: touch, rank }
    out.push(cand)
    // Высокий блоб с сужением — вероятно «голень+стопа»: сразу пробуем отрезать.
    if (allowSplit && box.height > 200 && box.height > 1.3 * box.width) {
      const cut = splitFootFromLeg(cv, cand, srcW, srcH, frameArea, t, dbg)
      if (cut) out.push(cut)
    }
  }
  return out
}

/**
 * Отрезает голень: ищет «щиколотку» (локальный минимум ширины маски
 * между голенью и стопой) и оставляет нижнюю часть — собственно стопу.
 */
function splitFootFromLeg(cv: Cv, cand: FootCandidate, srcW: number, srcH: number, frameArea: number, t: MatTracker, dbg?: FootDebug): FootCandidate | null {
  const box = cv.boundingRect(cand.contour)
  if (box.height < 60) return null

  // Ширина маски по строкам внутри bbox (со сглаживанием окном 9).
  const raw: number[] = []
  for (let y = box.y; y < box.y + box.height; y++) {
    let w = 0
    for (let x = box.x; x < box.x + box.width; x++) {
      if (cand.mask.ucharPtr(y, x)[0] > 0) w++
    }
    raw.push(w)
  }
  const widths: number[] = raw.map((_, i) => {
    let s = 0
    let n = 0
    for (let k = -4; k <= 4; k++) {
      const j = i + k
      if (j >= 0 && j < raw.length) {
        s += raw[j]
        n++
      }
    }
    return s / n
  })
  const bottomRows = Math.max(4, Math.floor(widths.length * 0.12))
  const bottomSlice = widths.slice(-bottomRows).sort((a, b) => a - b)
  const footW = bottomSlice[Math.floor(bottomSlice.length / 2)]
  dbg?.onInfo?.('leg_split', { boxH: box.height, boxW: box.width, footW: Math.round(footW), cut: null })
  if (footW <= 20) return null
  // Нет вытянутой голени — резать нечего.
  if (box.height < 1.25 * footW) return null

  // Сканируем снизу вверх: стопа — широкая часть внизу. Ищем устойчивое
  // сужение (щиколотку) выше неё; режем по нижней границе сужения.
  let narrowRun = 0
  let cutIdx = -1
  for (let i = widths.length - 1; i >= Math.floor(widths.length * 0.25); i--) {
    if (widths[i] < 0.55 * footW) {
      narrowRun++
      if (narrowRun >= 25) {
        cutIdx = i + narrowRun - 1
        break
      }
    } else {
      narrowRun = 0
    }
  }
  if (cutIdx < 0) return null // сужения нет — это и есть стопа
  // Срез, оставляющий меньше четверти высоты, — артефакт, а не щиколотка.
  if (cutIdx > widths.length * 0.75) return null
  dbg?.onInfo?.('leg_split_cut', { cutRow: box.y + cutIdx, footW: Math.round(footW), widthAtCut: Math.round(widths[cutIdx]) })

  // Обрезаем маску выше шеи.
  const cut = t.track(cand.mask.clone())
  const cutRow = box.y + cutIdx
  for (let y = 0; y < cutRow; y++) for (let x = 0; x < srcW; x++) cut.ucharPtr(y, x)[0] = 0

  // Крупнейшая компоненте ниже среза — стопа.
  const cands = collectFootCandidates(cv, cut, srcW, srcH, frameArea, t, undefined, false)
  let best: FootCandidate | null = null
  for (const c of cands) {
    if (!best || c.rank > best.rank) best = c
  }
  return best
}


function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return dist(px, py, ax + t * dx, ay + t * dy)
}

/**
 * Отрезает боковой «прирост» (тапок/предмет рядом с пяткой): ищем глубокую
 * впадину convexity defect у боковой кромки bbox и режем маску вертикально,
 * оставляя большую часть.
 */
function splitSideAttachment(
  cv: Cv,
  cand: FootCandidate,
  srcW: number,
  srcH: number,
  frameArea: number,
  t: MatTracker,
  dbg?: FootDebug
): FootCandidate | null {
  const cnt = cand.contour
  if (cnt.rows < 10) return null
  const hullIdx = t.track(new cv.Mat())
  cv.convexHull(cnt, hullIdx, false, false)
  const defects = t.track(new cv.Mat())
  try {
    cv.convexityDefects(cnt, hullIdx, defects)
  } catch {
    return null
  }
  if (defects.rows === 0) return null
  const box = cv.boundingRect(cnt)

  // Глубочайшая впадина у боковой кромки, на средней высоте bbox.
  let bestCutX = -1
  let bestDepth = 50 // минимальная глубина, px
  for (let i = 0; i < defects.rows; i++) {
    const d = defects.intPtr(i, 0) as ArrayLike<number>
    const s = d[0]
    const e = d[1]
    const f = d[2]
    if (s >= cnt.rows || e >= cnt.rows || f >= cnt.rows) continue
    const ps = cnt.intPtr(s, 0) as ArrayLike<number>
    const pe = cnt.intPtr(e, 0) as ArrayLike<number>
    const pf = cnt.intPtr(f, 0) as ArrayLike<number>
    const depth = pointSegDist(pf[0], pf[1], ps[0], ps[1], pe[0], pe[1])
    const xRel = (pf[0] - box.x) / box.width
    const yRel = (pf[1] - box.y) / box.height
    const side = xRel < 0.3 || xRel > 0.7
    const midBand = yRel > 0.2 && yRel < 0.9
    if (side && midBand && depth > bestDepth) {
      bestDepth = depth
      bestCutX = pf[0]
    }
  }
  if (bestCutX < 0) return null
  dbg?.onInfo?.('side_split', { cutX: bestCutX, depth: Math.round(bestDepth) })

  // Определяем меньшую половину по площади маски.
  const leftMask = t.track(cand.mask.clone())
  for (let y = 0; y < srcH; y++) for (let x = bestCutX; x < srcW; x++) leftMask.ucharPtr(y, x)[0] = 0
  const rightMask = t.track(cand.mask.clone())
  for (let y = 0; y < srcH; y++) for (let x = 0; x < bestCutX; x++) rightMask.ucharPtr(y, x)[0] = 0
  const leftArea = cv.countNonZero(leftMask)
  const rightArea = cv.countNonZero(rightMask)
  const keep = leftArea >= rightArea ? leftMask : rightMask

  const cands = collectFootCandidates(cv, keep, srcW, srcH, frameArea, t, dbg, false)
  let best: FootCandidate | null = null
  for (const c of cands) {
    if (!best || c.rank > best.rank) best = c
  }
  return best
}

/**
 * Морфологическая реконструкция: ядро кандидата раздуваем обратно
 * внутрь полной маски прохода. Тонкие мосты к посторонним объектам
 * (тапок, мебель, тень) разрываются эрозией и не восстанавливаются —
 * получаем чистый контур стопы без потери размера.
 */
function reconstructFoot(
  cv: Cv,
  cand: FootCandidate,
  srcW: number,
  srcH: number,
  frameArea: number,
  t: MatTracker,
  dbg?: FootDebug
): FootCandidate | null {
  if (!cand.fullMask) return null
  // Мягкий возврат размера: ядро меньше эрозии — мосты не восстанавливаются.
  const kernelGrow = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15)))
  const grown = t.track(new cv.Mat())
  cv.dilate(cand.mask, grown, kernelGrow)
  const refined = t.track(new cv.Mat())
  cv.bitwise_and(grown, cand.fullMask, refined)
  const cands = collectFootCandidates(cv, refined, srcW, srcH, frameArea, t, dbg, false)
  let best: FootCandidate | null = null
  for (const c of cands) {
    if (!best || c.rank > best.rank) best = c
  }
  return best
}

/**
 * Измеряет стопу по фото.
 * @returns замер; эталон и стопа ищутся независимо — см. флаги referenceFound/footFound.
 * @param debug опциональный колбэк для дампа промежуточных масок (харнесс).
 */
export function measureFoot(imageData: ImageData, debug?: FootDebug): FootMeasurement {
  const cv = getOpenCv()
  const t = new MatTracker()
  try {
    const src = t.track(cv.matFromImageData(imageData))
    const frameArea = src.rows * src.cols

    const gray = t.track(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blurred = t.track(new cv.Mat())
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    // Сильное размытие для пороговой сегментации: гасит текстуру паркета,
    // крупные объекты (носок) сохраняются.
    const blurredBig = t.track(new cv.Mat())
    cv.GaussianBlur(gray, blurredBig, new cv.Size(13, 13), 0)

    const edges = t.track(new cv.Mat())
    cv.Canny(blurred, edges, 50, 150)
    debug?.onMask('1_edges', edges)

    // --- Эталон калибровки ---
    const reference = findReference(cv, edges, blurred, frameArea, t, debug)
    activeRefBounds = reference ? quadBounds(reference.quad) : null
    // Ожидаемая площадь стопы (~265×115 мм, заполнение ~0.65) для ранжирования.
    expectedFootAreaPx = reference ? Math.round((0.65 * 265 * 115) / (reference.mmPerPx * reference.mmPerPx)) : null

    const hsv = t.track(new cv.Mat())
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB)
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV)

    // --- Сегментация стопы ---
    const kernel = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)))
    const kernelSmall = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)))
    const kernelErode = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(35, 35)))
    const thresh = t.track(new cv.Mat())
    const morph = t.track(new cv.Mat())

    let foot: FootCandidate | null = null
    const consider = (binary: CvMat, label: string): FootCandidate | null => {
      // Мягкий open (3×3) не разрушает текстуру носка, close лечит разрывы.
      cv.morphologyEx(binary, morph, cv.MORPH_OPEN, kernelSmall)
      cv.morphologyEx(morph, morph, cv.MORPH_CLOSE, kernel)
      // Обрезаем полосу у границ кадра: цепочки тёмных объектов вдоль края
      // (штаны → тапок → паркет) иначе сливаются в один бесполезный блоб.
      const m = 12
      for (let y = 0; y < morph.rows; y++) {
        for (let x = 0; x < Math.min(m, morph.cols); x++) morph.ucharPtr(y, x)[0] = 0
        for (let x = Math.max(0, morph.cols - m); x < morph.cols; x++) morph.ucharPtr(y, x)[0] = 0
      }
      for (let x = 0; x < morph.cols; x++) {
        for (let y = 0; y < Math.min(m, morph.rows); y++) morph.ucharPtr(y, x)[0] = 0
        for (let y = Math.max(0, morph.rows - m); y < morph.rows; y++) morph.ucharPtr(y, x)[0] = 0
      }
      // Полная маска прохода — база для реконструкции после эрозии.
      const fullMask = t.track(morph.clone())
      // Эрозия разрывает тонкие мосты к посторонним тёмным объектам.
      cv.erode(morph, morph, kernelErode)
      debug?.onMask(label, morph)
      let best: FootCandidate | null = null
      for (const cand of collectFootCandidates(cv, morph, src.cols, src.rows, frameArea, t, debug)) {
        cand.fullMask = fullMask
        if (!best || cand.rank > best.rank) best = cand
      }
      return best
    }
    for (const inv of [false, true]) {
      const flag = (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU
      cv.threshold(blurredBig, thresh, 0, 255, flag)
      const c = consider(thresh, inv ? '3_binary_dark' : '2_binary_bright')
      if (c && (!foot || c.rank > foot.rank)) foot = c
    }
    // Третий источник: kmeans-разделение яркости (тёмный класс),
    // минус «тёплые» пиксели (паркет, доски, кожа) — иначе тёмный пол
    // слипается с носком и раздувает контур.
    const km = kmeansDarkMask(cv, blurredBig, t)
    if (km) {
      const warm = t.track(new cv.Mat())
      const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 40, 0, 0])
      const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 255, 255, 0])
      cv.inRange(hsv, lower, upper, warm)
      lower.delete()
      upper.delete()
      const notWarm = t.track(new cv.Mat())
      cv.bitwise_not(warm, notWarm)
      const cool = t.track(new cv.Mat())
      cv.bitwise_and(km, notWarm, cool)
      const c = consider(cool, '3b_kmeans_dark')
      if (c && (!foot || c.rank > foot.rank)) foot = c
    }

    // Отрезаем боковые приросты (предметы рядом с пяткой/носком).
    if (foot) {
      const splitC = splitSideAttachment(cv, foot, src.cols, src.rows, frameArea, t, debug)
      if (splitC && splitC.rank >= foot.rank) foot = splitC
    }

    // Отрезаем голень по «щиколотке», если она попала в кадр.
    if (foot) {
      debug?.onMask('4_foot_raw', foot.mask)
      const cut = splitFootFromLeg(cv, foot, src.cols, src.rows, frameArea, t, debug)
      if (cut && cut.rank > foot.rank) foot = cut
    }

    // Реконструкция: отделяем стопу от слипшихся тёмных объектов.
    if (foot) {
      const reconstructed = reconstructFoot(cv, foot, src.cols, src.rows, frameArea, t, debug)
      if (reconstructed && reconstructed.rank > foot.rank) foot = reconstructed
    }
    activeRefBounds = null
    expectedFootAreaPx = null
    debug?.onMask('5_foot_final', foot?.mask ?? morph)
    debug?.onInfo?.('foot_chosen', foot ? { rank: foot.rank, areaPct: Math.round((foot.area / frameArea) * 1000) / 10, touch: Math.round(foot.borderTouch * 100) / 100 } : { none: true })

    const empty: FootMeasurement = {
      lengthMm: null,
      widthMm: null,
      footContour: [],
      referenceFound: reference !== null,
      footFound: foot !== null && foot.rank >= 1.5,
      referenceKind: reference?.kind ?? null
    }
    if (!foot || !empty.footFound) return empty

    // Контур стопы (упрощённый hull). Вершины у левого/правого края кадра
    // отбрасываем: это срезы объекта рамкой или прилипшие предметы (тапок).
    const hull = t.track(new cv.Mat())
    cv.convexHull(foot.contour, hull, false, true)
    const allHullPts = contourPoints(hull)
    const xLo = 0.04 * src.cols
    const xHi = 0.96 * src.cols
    const trimmed = allHullPts.filter((p) => p.x >= xLo && p.x <= xHi)
    // Если обрезка съела почти весь контур (объект у края) — не обрезаем.
    const hullPts = trimmed.length >= 6 ? trimmed : allHullPts
    const step = Math.max(1, Math.floor(hullPts.length / 150))
    empty.footContour = hullPts.filter((_, i) => i % step === 0)

    if (!reference) return empty

    // --- Измерения ---
    // Длина: максимальное попарное расстояние по hull.
    let lengthPx = 0
    for (let i = 0; i < hullPts.length; i++) {
      for (let j = i + 1; j < hullPts.length; j++) {
        const d = dist(hullPts[i].x, hullPts[i].y, hullPts[j].x, hullPts[j].y)
        if (d > lengthPx) lengthPx = d
      }
    }
    // Ширина: малая сторона bounding box минимальной площади.
    const rect = cv.minAreaRect(foot.contour)
    const widthPx = Math.min(rect.size.width, rect.size.height)

    let lengthMm = lengthPx * reference.mmPerPx
    let widthMm = widthPx * reference.mmPerPx
    if (widthMm > lengthMm) [lengthMm, widthMm] = [widthMm, lengthMm]

    // Sanity-guard: нереальный размер => эталон скорее всего ложный
    // (коробка/радиатор похожи на А4). Калибровку отбрасываем, контур стопы сохраняем.
    if (lengthMm < 120 || lengthMm > 360 || widthMm < 40 || widthMm > 320) {
      debug?.onInfo?.('reference_rejected', { lengthMm: Math.round(lengthMm), widthMm: Math.round(widthMm) })
      empty.referenceFound = false
      empty.referenceKind = null
      return empty
    }

    empty.lengthMm = Math.round(lengthMm * 10) / 10
    empty.widthMm = Math.round(widthMm * 10) / 10
    return empty
  } finally {
    t.dispose()
  }
}
