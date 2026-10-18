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

/** Ракурс съёмки: сверху / сбоку / спереди (45°). */
export type FootView = 'top' | 'side' | 'front'

/** Какие метрики наполняются по ракурсу:
 *  top — lengthMm/widthMm; side — lengthMm (кросс-проверка) + instepHeightMm;
 *  front — ballWidthMm (+ длина по hull для кросс-проверки). */
export interface FootMeasurement {
  /** Ракурс съёмки. */
  view: FootView
  /** Длина стопы, мм (null, если нет эталона или стопы). */
  lengthMm: number | null
  /** Ширина стопы (по minAreaRect), мм — ракурс top. */
  widthMm: number | null
  /** Высота подъёма над линией пола, мм — ракурс side (нужен эталон). */
  instepHeightMm: number | null
  /** Относительный подъём: высота контура над линией пола / длина контура (0..1).
   *  Ракурс side БЕЗ эталона — перевод в мм делается в footModel через длину
   *  из top-ракурса. */
  instepRatio: number | null
  /** Ширина переднего отдела (ball), мм — ракурс front. */
  ballWidthMm: number | null
  /** Контур стопы (упрощённый hull) в пикселях кадра. */
  footContour: FootContourPoint[]
  /** Найден ли эталон для калибровки масштаба. */
  referenceFound: boolean
  /** Найдена ли стопа. */
  footFound: boolean
  /** Тип найденного эталона. */
  referenceKind: ReferenceKind | null
  /** NN определила, что на стопе носок (класс одежды, нет кожи в нижней части). */
  sockDetected: boolean
}

export interface PersonMask {
  /** Классы пикселей (0 bg, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 acc). */
  mask: Uint8Array
  width: number
  height: number
}

export interface MeasureOptions {
  view?: FootView
  /** NN-маска «человек/фон» (MediaPipe selfie multiclass). null/undefined — классика. */
  personMask?: PersonMask | null
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
const POLY_EPS_FRACS = [0.01, 0.02, 0.035, 0.05, 0.08]
/** Минимальная короткая сторона эталона, px (иначе масштаб неточен). */
const REF_MIN_SHORT_SIDE_PX = 40
/** Площадь стопы: 1–50% кадра (без эталона — тот же диапазон). */
const FOOT_MIN_AREA_FRAC = 0.01
const FOOT_MAX_AREA_FRAC = 0.35
/** Допустимое отношение длины стопы к ширине (по minAreaRect). */
const FOOT_ASPECT_MIN = 1.05
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
  /** Квад из bright-прохода: лист частично закрыт стопой — допуск ratio шире,
   * скор ниже (уступает точным Canny-квадам). */
  fromBright?: boolean
  /** Сильная геометрия (чистый poly 4 вершины, ratio в допуске, площадь >4%
   * кадра): цвет листа не важен — яркостные гейты пропускаем. */
  geoStrong?: boolean
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
  if (quad.internalEdgeDensity > 0.03) {
    dbg?.onInfo?.('ref_reject', { why: 'edgeDensity', d: Math.round(quad.internalEdgeDensity * 1000) / 1000 })
    return null
  }
  const sides = sortedSides(quad.pts)
  const shortPx = (sides[0] + sides[1]) / 2
  if (shortPx < REF_MIN_SHORT_SIDE_PX) {
    dbg?.onInfo?.('ref_reject', { why: 'short', shortPx: Math.round(shortPx) })
    return null
  }
  const ratio = sides[3] / sides[0]
  if (sides[0] <= 0) return null
  // Bright-квады: стопа закрывает часть листа — длинная сторона усечена,
  // ratio занижен. Широкий допуск ок: печать отсекает density, светлость —
  // относительный гейт. Скор занижен — точные Canny-квады выигрывают.
  // Геометрически сильные квады (чистый poly, крупные): цвет листа не важен.
  const tol = quad.fromBright ? 0.35 : quad.geoStrong ? 0.28 : RATIO_TOLERANCE
  if (Math.abs(ratio - 1.414) > tol && Math.abs(ratio - 1.586) > tol) {
    dbg?.onInfo?.('ref_reject', { why: 'ratio', ratio: Math.round(ratio * 100) / 100 })
    return null
  }

  // Средняя яркость внутри квада: бумага/карта — светлые.
  let brightness = 0
  if (quad.roi) {
    const mean = cv.mean(quad.roi) as unknown as ArrayLike<number>
    brightness = mean[0]
  }

  let best: ReferenceMatch | null = null
  for (const ref of REFERENCES) {
    const err = Math.abs(ratio - ref.ratio)
    if (err > tol) continue
    // Основной критерий — близость ratio; бонусы: точность poly, светлость.
    let score = (quad.fromBright ? 0.28 : RATIO_TOLERANCE) - err + (quad.isPoly ? 0.05 : 0)
    if (brightness > 220) score += 0.1
    else if (brightness > 195) score += 0.03
    if (!best || score > best.score) {
      best = { kind: ref.kind, mmPerPx: ref.shortMm / shortPx, score, brightness, quad }
    }
  }
  if (best) {
    const b = quadBounds(quad)
    const sd = sortedSides(quad.pts).map((v) => Math.round(v))
    dbg?.onInfo?.('ref_quad', {
      matched: best.kind,
      ratio: Math.round(ratio * 100) / 100,
      brightness: Math.round(brightness),
      bbox: [b.x, b.y, b.w, b.h],
      sides: sd,
      pts: quad.pts.map((p) => [p.x, p.y]),
      isPoly: quad.isPoly,
      score: Math.round(best.score * 1000) / 1000
    })
  }
  return best
}

/** Квад из minAreaRect (fallback, когда approxPolyDP не сошёлся). */
function quadFromMinAreaRect(rect: { center: { x: number; y: number }; size: { width: number; height: number }; angle: number }, area: number): Quad | null {
  const w = rect.size.width
  const h = rect.size.height
  if (w <= 0 || h <= 0) return null
  const angle = (rect.angle * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const hw = w / 2
  const hh = h / 2
  return {
    pts: [
      { x: Math.round(rect.center.x - hw * cos + hh * sin), y: Math.round(rect.center.y - hw * sin - hh * cos) },
      { x: Math.round(rect.center.x + hw * cos + hh * sin), y: Math.round(rect.center.y + hw * sin + hh * cos) },
      { x: Math.round(rect.center.x + hw * cos - hh * sin), y: Math.round(rect.center.y + hw * sin + hh * cos) },
      { x: Math.round(rect.center.x - hw * cos - hh * sin), y: Math.round(rect.center.y - hw * sin + hh * cos) }
    ],
    areaPx: area,
    isPoly: false,
    roi: null,
    internalEdgeDensity: 0
  }
}

/** ROI grayscale + плотность внутренних эджей по bbox квада. */
function finishQuad(cv: Cv, quad: Quad, gray: CvMat, edges: CvMat, t: MatTracker): void {
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
}

/** approxPolyDP с растущим ε → 4 выпуклые вершины, иначе null. */
function polyQuad(cv: Cv, cnt: CvMat, peri: number, t: MatTracker): FootContourPoint[] | null {
  for (const epsFrac of POLY_EPS_FRACS) {
    const approx = t.track(new cv.Mat())
    cv.approxPolyDP(cnt, approx, epsFrac * peri, true)
    if (approx.rows === 4 && cv.isContourConvex(approx)) return contourPoints(approx)
  }
  return null
}

/** Собирает квад-кандидатов из Canny-эджей + bright-прохода. */
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
    // 1) approxPolyDP с растущим ε — ищем ровно 4 вершины.
    let pts = polyQuad(cv, cnt, peri, t)
    let isPoly = pts !== null
    // 2) Fallback: minAreaRect (грязные края реальной бумаги/карты).
    if (!pts) {
      const q = quadFromMinAreaRect(cv.minAreaRect(cnt), area)
      if (q) {
        pts = q.pts
        isPoly = false
      }
    }
    if (pts) {
      const quad: Quad = { pts, areaPx: area, isPoly, roi: null, internalEdgeDensity: 0 }
      // Сильная геометрия: точный poly, крупный (>4% кадра) — цвет листа
      // не важен, яркостные гейты пропускаем.
      if (isPoly && area > frameArea * 0.04) quad.geoStrong = true
      finishQuad(cv, quad, gray, edges, t)
      quads.push(quad)
    }
  }

  // --- Bright-pass: у телефонных фото край белого листа на тёплом полу —
  // слабый широкий градиент, Canny после blur его теряет (phone-top давал
  // 0 квадов из эджей). Выделяем светлые регионы (относительно среднего
  // кадра) и строим квады по их внешним контурам. Печатные поверхности
  // (крышка коробки 12-39-20) отсекает internalEdgeDensity. ---
  const frameMean = (cv.mean(gray) as unknown as ArrayLike<number>)[0]
  if (frameMean > 0) {
    const brightTh = t.track(new cv.Mat())
    cv.threshold(gray, brightTh, frameMean * 1.28, 255, cv.THRESH_BINARY)
    // Широкий горизонтальный close: стопа/голень режут лист на две половины
    // — мост между ними (у мысков полоса узкая). Без этого половинки дают
    // квады со случайным ratio.
    const bKernel = t.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(75, 25)))
    const bClosed = t.track(new cv.Mat())
    cv.morphologyEx(brightTh, bClosed, cv.MORPH_CLOSE, bKernel)
    const bContours = t.track(new cv.MatVector())
    const bHier = t.track(new cv.Mat())
    cv.findContours(bClosed, bContours, bHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < bContours.size(); i++) {
      const cnt = t.track(bContours.get(i))
      const area = cv.contourArea(cnt)
      if (area < frameArea * REF_MIN_AREA_FRAC) continue
      const peri = cv.arcLength(cnt, true)
      let pts = polyQuad(cv, cnt, peri, t)
      let isPoly = pts !== null
      if (!pts) {
        const q = quadFromMinAreaRect(cv.minAreaRect(cnt), area)
        if (q) {
          pts = q.pts
          isPoly = false
        }
      }
      if (pts) {
        const quad: Quad = { pts, areaPx: area, isPoly, roi: null, internalEdgeDensity: 0, fromBright: true }
        finishQuad(cv, quad, gray, edges, t)
        quads.push(quad)
      }
    }
  }
  return quads
}

/** Ищет эталон калибровки. null — не найден. */
function findReference(cv: Cv, edges: CvMat, gray: CvMat, frameArea: number, t: MatTracker, dbg?: FootDebug): ReferenceMatch | null {
  const quads = collectQuads(cv, edges, gray, frameArea, t)
  dbg?.onInfo?.('ref_quads_total', { quads: quads.length })
  let best: ReferenceMatch | null = null
  for (const quad of quads) {
    const m = matchReference(cv, quad, dbg)
    if (m && (!best || m.score > best.score)) best = m
  }
  // Слабый скор при НЕсветлости относительно кадра — сомнительный объект
  // (коробка, рама), а не бумага. Абсолютный порог яркости неверен: вечерний
  // свет даёт белый лист brightness ~190. Печатные поверхности дополнительно
  // ловит internalEdgeDensity.
  if (best && best.score < 0.3 && !best.quad.geoStrong) {
    const frameMean = (cv.mean(gray) as unknown as ArrayLike<number>)[0]
    if (best.brightness < frameMean * 1.08 + 12) return null
  }
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
  /** Кандидат из дырок bright-маски: auxMask = сама bright-маска. */
  isHole?: boolean
  auxMask?: CvMat
  /** Кандидат из NN-маски «человек/фон» — доверенный источник. */
  isNN?: boolean
  area: number
  /** Доля точек контура, касающихся границ кадра (0 — не касается). */
  borderTouch: number
  /** Оценка «похожести на стопу» — чем выше, тем лучше. */
  rank: number
}

/** Прямоугольник квада эталона с запасом, или null. */
let activeRefBounds: { x: number; y: number; w: number; h: number } | null = null

/** Пересекается ли контур с зоной эталона. Центроид-проверка — только для
 * блобов близких к размеру эталона: у гигантских блобов (скриншотная рамка,
 * сцена целиком) центроид часто случайно попадает в зону листа. */
/** Доля точек контура внутри зоны эталона (с запасом 10px). */
function referenceOverlapFraction(_cv: Cv, cnt: CvMat, bounds: { x: number; y: number; w: number; h: number }): number {
  let inside = 0
  for (let i = 0; i < cnt.rows; i++) {
    const p = cnt.intPtr(i, 0) as ArrayLike<number>
    if (p[0] >= bounds.x - 10 && p[0] <= bounds.x + bounds.w + 10 && p[1] >= bounds.y - 10 && p[1] <= bounds.y + bounds.h + 10) {
      inside++
    }
  }
  return cnt.rows > 0 ? inside / cnt.rows : 0
}

function overlapsReference(cv: Cv, cnt: CvMat, bounds: { x: number; y: number; w: number; h: number }): boolean {
  const box = cv.boundingRect(cnt)
  // Точки контура внутри зоны эталона: bbox-перекрытие ненадёжно (тонкое
  // кольцо стопы рядом с листом имеет большой bbox, но не касается листа).
  const frac = referenceOverlapFraction(cv, cnt, bounds)
  if (frac > 0.25 && box.width * box.height < 2.5 * bounds.w * bounds.h) return true
  // Почти весь блоб внутри зоны эталона (сам лист в bright-масках).
  const area = Math.abs(cv.contourArea(cnt))
  const overlapW = Math.min(box.x + box.width, bounds.x + bounds.w) - Math.max(box.x, bounds.x)
  const overlapH = Math.min(box.y + box.height, bounds.y + bounds.h) - Math.max(box.y, bounds.y)
  if (area > 0 && overlapW > 0 && overlapH > 0 && overlapW * overlapH > 0.8 * area && area < 2.5 * bounds.w * bounds.h) {
    return true
  }
  const m = cv.moments(cnt)
  if (m.m00 > 0 && box.width * box.height < 2.5 * bounds.w * bounds.h) {
    const cx = m.m10 / m.m00
    const cy = m.m01 / m.m00
    if (cx >= bounds.x - 10 && cx <= bounds.x + bounds.w + 10 && cy >= bounds.y - 10 && cy <= bounds.y + bounds.h + 10) {
      return true
    }
  }
  return false
}

/** Обрезать полосу у границ маски. */
function stripBorders(cv: Cv, mat: CvMat, m: number): void {
  void cv
  const w = mat.cols
  const h = mat.rows
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.min(m, w); x++) mat.ucharPtr(y, x)[0] = 0
    for (let x = Math.max(0, w - m); x < w; x++) mat.ucharPtr(y, x)[0] = 0
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < Math.min(m, h); y++) mat.ucharPtr(y, x)[0] = 0
    for (let y = Math.max(0, h - m); y < h; y++) mat.ucharPtr(y, x)[0] = 0
  }
}

/** Ранк для обрезанной части стопы: без extent-проверки (после горизонтального
 *  среза часть заполняет bbox почти сплошным блоком — это нормально). */
function rankCutPart(cv: Cv, cnt: CvMat, area: number, touch: number, frameArea: number, frameH: number): number {
  void frameH
  // Позиционные проверки (центроид в нижней части кадра) НЕ применяем:
  // это часть уже принятого кандидата, стопа может быть в любой части кадра.
  let rank = 0
  if (area < frameArea * FOOT_MIN_AREA_FRAC || area > frameArea * FOOT_MAX_AREA_FRAC) return rank
  const m = cv.moments(cnt)
  if (m.m00 <= 0) return rank
  const rect = cv.minAreaRect(cnt)
  const long = Math.max(rect.size.width, rect.size.height)
  const short = Math.min(rect.size.width, rect.size.height)
  // Обрезанная часть может быть шире обычной стопы (срез по щиколотке) —
  // верхнюю границу aspect ослабляем.
  if (short <= 0 || long / short < FOOT_ASPECT_MIN || long / short > 10) return rank
  rank += 2
  if (touch < 0.02) rank += 1
  else if (touch < 0.15) rank += 0.5
  rank += Math.min(area / frameArea, 0.2)
  return rank
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
/** Жёсткий размерный отсев кандидатов (выключается как fallback, если все отсеяны). */
let sizeGateEnabled = true
/** Текущий ракурс и средняя яркость кадра — для view-aware ранкинга. */
let currentView: FootView = 'top'
let frameMeanGray = 0
/** Grayscale кадра — для оценки яркости кандидатов (side-ракурс). */
let currentGray: CvMat | null = null
/** HSV кадра — paper-детекция кандидатов (side-ракурс). */
let currentHsv: CvMat | null = null
/** mm/px эталона (null без эталона) — для стратегии полосы в splitFootFromLeg. */
let currentMmPerPx: number | null = null
/** Все кандидаты проходов текущего кадра — для fallback-перебора (side). */
let allCandidates: FootCandidate[] = []

/** Комплексная оценка кандидата: форма + касание границ + позиция + размер. */
function rankCandidate(cv: Cv, cnt: CvMat, area: number, touch: number, frameArea: number, frameH: number): number {
  let rank = 0
  // Гигантские блобы (>40% кадра) — почти всегда слияние объекта с фоном
  // (босая стопа на солнечном паркете). Стопа+голень — обычно 5–25%.
  if (area > frameArea * 0.4) rank -= 2
  // Мелкий блоб у края кадра — тень/мусор; не должен обыгрывать среднего
  // кандидата со формой стопы.
  if (touch >= 0.1 && area < frameArea * 0.02) rank -= 1
  // Side-ракурс: стопа тёмная/текстурная и ВЫТЯНУТАЯ горизонтально; лист на
  // полу — яркий, фон — часто полоса на всю ширину кадра.
  if (currentView === 'side') {
    const sBox = cv.boundingRect(cnt)
    const frameW = frameArea / frameH
    if (sBox.width > 4 && sBox.height > 4 && currentGray) {
      const roi = cv.mean(currentGray.roi({ x: sBox.x, y: sBox.y, width: sBox.width, height: sBox.height })) as unknown as ArrayLike<number>
      if (frameMeanGray > 0 && roi[0] > frameMeanGray * 1.35 + 10) rank -= 2 // белизна/лист, а не кожа
    }
    const sAspect = Math.max(sBox.width, sBox.height) / Math.max(1, Math.min(sBox.width, sBox.height))
    if (sAspect >= 2.2) rank += 0.5 // стопа сбоку — вытянутая («пятка-носок»)
    if (sBox.width > frameW * 0.7 || sBox.height > frameH * 0.7) rank -= 1 // полоса фона
  }
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

/** Возвращает лучшего из двух кандидатов (null-безопасно).
 *  Дырки bright-маски получают бонус: их контур точный (без эрозии). */
/**
 * Вертикальный срез голени для top: нога входит сверху/сбоку, стопа тянется
 * в сторону. Режем по правой границе столба верхней трети bbox — остаётся стопа.
 */
function cutLegColumn(
  cv: Cv,
  cand: FootCandidate,
  srcW: number,
  srcH: number,
  frameArea: number,
  t: MatTracker,
  dbg?: FootDebug
): FootCandidate | null {
  const box = cv.boundingRect(cand.contour)
  if (box.height < 60) return null
  // Столб голени: пиксели есть в верхней части bbox, но НЕТ в нижней
  // (щиколотка опирается в стопу — её колонки имеют пиксели снизу).
  const topY1 = box.y + Math.floor(box.height * 0.4)
  const botY0 = box.y + Math.floor(box.height * 0.6)
  let legRight = -1
  for (let x = box.x; x < box.x + box.width; x++) {
    let hasTop = false
    let hasBot = false
    for (let y = box.y; y <= Math.min(topY1, srcH - 1); y++) {
      if (cand.mask.ucharPtr(y, x)[0] > 0) {
        hasTop = true
        break
      }
    }
    if (hasTop) {
      for (let y = botY0; y <= Math.min(box.y + box.height, srcH - 1); y++) {
        if (cand.mask.ucharPtr(y, x)[0] > 0) {
          hasBot = true
          break
        }
      }
      if (!hasBot) legRight = x
    }
  }
  if (legRight < 0) return null
  const cutX = Math.min(box.x + box.width - 10, legRight + Math.round(box.width * 0.05))
  const rightMask = t.track(cand.mask.clone())
  for (let y = 0; y < srcH; y++) for (let x = 0; x < cutX; x++) rightMask.ucharPtr(y, x)[0] = 0
  const rightArea = cv.countNonZero(rightMask)
  if (rightArea < cand.area * 0.3) return null
  // Лучший НИЖНИЙ фрагмент по площади (стопа), rankCutPart — только бонус.
  const fragCands = collectFootCandidates(cv, rightMask, srcW, srcH, frameArea, t, dbg, false, false)
  let best: FootCandidate | null = null
  let bestBottom = -1
  for (const c of fragCands) {
    if (c.area < frameArea * 0.004) continue
    const b = cv.boundingRect(c.contour)
    if (b.y + b.height > bestBottom) {
      bestBottom = b.y + b.height
      best = c
    }
  }
  if (!best && sizeGateEnabled) {
    sizeGateEnabled = false
    for (const c of collectFootCandidates(cv, rightMask, srcW, srcH, frameArea, t, dbg, false, false)) {
      if (c.area < frameArea * 0.004) continue
      const b = cv.boundingRect(c.contour)
      if (b.y + b.height > bestBottom) {
        bestBottom = b.y + b.height
        best = c
      }
    }
    sizeGateEnabled = true
  }
  if (best) {
    best.rank = Math.max(best.rank, rankCutPart(cv, best.contour, best.area, best.borderTouch, frameArea, srcH))
    dbg?.onInfo?.('leg_column_cut', { cutX, rank: Math.round(best.rank * 100) / 100, areaPct: Math.round((best.area / frameArea) * 1000) / 10 })
  }
  return best
}

function betterCandidate(a: FootCandidate | null, b: FootCandidate | null): FootCandidate | null {
  if (b === null) return a
  if (a === null) return b
  const aScore = a.rank + (a.isHole ? 0.5 : 0)
  const bScore = b.rank + (b.isHole ? 0.5 : 0)
  return bScore > aScore ? b : a
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
  allowSplit = true,
  checkRef = true,
  skipPaperCheck = false
): FootCandidate[] {
  const contours = t.track(new cv.MatVector())
  const hierarchy = t.track(new cv.Mat())
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

  const out: FootCandidate[] = []
  let skipSmall = 0
  let skipRef = 0
  let skipGate = 0
  let skipPaper = 0
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i)
    const area = cv.contourArea(cnt)
    if (area < frameArea * (FOOT_MIN_AREA_FRAC / 4)) {
      skipSmall++
      cnt.delete()
      continue
    }
    // При наличии эталона: отсекаем объекты, чей размер несовместим со стопой
    // (слипшаяся мебель, коробка, участки пола). Если отсев убивает всех —
    // вызывающий код отключит его (fallback).
    if (sizeGateEnabled && expectedFootAreaPx && expectedFootAreaPx > 0 && (area < 0.35 * expectedFootAreaPx || area > 3.0 * expectedFootAreaPx)) {
      skipGate++
      cnt.delete()
      continue
    }
    // Стопа может лежать НА листе (phone-top): её контур целиком внутри зоны
    // эталона. Глубокое перекрытие (большая доля точек внутри) + размер
    // меньше эталона → это стопа на листе, НЕ отсекаем. Иначе — старое
    // поведение: перекрывающие эталон блобы (сам лист) отсекаются.
    if (checkRef && activeRefBounds) {
      const refArea = activeRefBounds.w * activeRefBounds.h
      // «Стопа на листе» (phone-top): только крупные листы (≥8% кадра) —
      // контур стопы целиком внутри зоны эталона. Карта/мелкий эталон рядом
      // со стопой — старое поведение (перекрывающие блобы отсекаются).
      const footOnPaper =
        refArea > frameArea * 0.08 && referenceOverlapFraction(cv, cnt, activeRefBounds) > 0.55 && area < refArea * 0.8
      if (!footOnPaper && overlapsReference(cv, cnt, activeRefBounds)) {
        skipRef++
        cnt.delete()
        continue
      }
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
    // Side: крупный яркий ненасыщенный РАВНОМЕРНЫЙ блоб — лист/бумага на полу,
    // а не стопа (носок/кожа тёмные или насыщенные или текстурные). stdV
    // отличает бумагу от яркой босой кожи. Для hole-кандидатов пропускаем:
    // их заливка по построению — яркое нутро (тёмное кольцо на светлом).
    if (!skipPaperCheck && currentView === 'side' && currentHsv && area > frameArea * 0.02) {
      const hsvRoi = currentHsv.roi(box)
      const maskRoi = mask.roi(box)
      const mean = cv.mean(hsvRoi, maskRoi) as unknown as ArrayLike<number>
      hsvRoi.delete()
      maskRoi.delete()
      // stdV яркости — бумага равномерна (stdV низкий), кожа/носки текстурны.
      let n = 0
      let vSum = 0
      let vSq = 0
      for (let y = box.y; y < box.y + box.height; y += 2) {
        for (let x = box.x; x < box.x + box.width; x += 2) {
          if (mask.ucharPtr(y, x)[0] === 0) continue
          const v = currentHsv.ucharPtr(y, x)[2]
          n++
          vSum += v
          vSq += v * v
        }
      }
      const stdV = n > 0 ? Math.sqrt(Math.max(0, vSq / n - (vSum / n) * (vSum / n))) : 0
      // extent: бумага — плотный прямоугольник; слитая с полом босая стопа
      // (тоже яркая/ненасыщенная) — аморфный блоб с низким заполнением bbox.
      const extent = area / Math.max(1, box.width * box.height)
      // extent: только плотный прямоугольный лист (typ. >0.9). Слитая с полом
      // солнечная босая стопа — яркий/ненасыщенный/равномерный компактный блоб
      // тоже (extent ~0.83) — по HSV-среднему неотличима от бумаги, ловить её
      // нельзя: весь side-харнесс уходит в регресс. Порог 0.9 — консервативный.
      // Ветка карты: маленький плотный светлый квад (карта рядом/у стопы).
      const areaPct = (area / frameArea) * 100
      const isCard = mean[2] > 170 && mean[1] < 80 && extent > 0.85 && areaPct < 12
      const isPaper = (mean[2] > 165 && mean[1] < 75 && stdV < 30 && extent > 0.9) || isCard
      dbg?.onInfo?.('paper_check', {
        areaPct: Math.round((area / frameArea) * 1000) / 10,
        meanV: Math.round(mean[2]),
        meanS: Math.round(mean[1]),
        stdV: Math.round(stdV),
        extent: Math.round(extent * 100) / 100,
        rejected: isPaper
      })
      if (isPaper) {
        skipPaper++
        cnt.delete()
        continue
      }
    }
    const cand: FootCandidate = { contour: cnt, mask, area, borderTouch: touch, rank }
    out.push(cand)
    // Высокий блоб с сужением — вероятно «голень+стопа»: сразу пробуем отрезать.
    // Сбоку нога+стопа почти квадратны — пробуем шире (max-width стратегия
    // внутри splitFootFromLeg сама решит, есть где резать).
    const tallEnough = box.height > 1.3 * box.width || (currentView === 'side' && box.height > 200 && box.width > 150)
    if (allowSplit && box.height > 200 && tallEnough) {
      const cut = splitFootFromLeg(cv, cand, srcW, srcH, frameArea, t, dbg)
      if (cut) out.push(cut)
    }
  }
  if (dbg && (skipSmall || skipRef || skipGate || skipPaper)) {
    dbg.onInfo?.('collect_skips', { total: contours.size(), small: skipSmall, ref: skipRef, gate: skipGate, paper: skipPaper, gateOn: sizeGateEnabled })
  }
  allCandidates.push(...out)
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
  // Нет вытянутой голени — резать нечего. Сбоку голень+стопа почти квадратны —
  // порог ниже, чем сверху.
  if (currentView !== 'side' && box.height < 1.25 * footW) return null

  // Сканируем снизу вверх: стопа — широкая часть внизу. Ищем устойчивое
  // сужение (щиколотку) выше неё; режем по нижней границе сужения.
  if (cand.isNN && currentView === 'top' && currentMmPerPx && currentMmPerPx > 0) {
    dbg?.onInfo?.('band_entry', { mmPerPx: Math.round(currentMmPerPx * 100) / 100, boxH: box.height })
    // Стратегия для top: «нога+стопа» по диагонали. Берём горизонтальную
    // полосу высотой ~длина стопы в px, где масса маски максимальна
    // (нога узкая, стопа широкая), — это и есть стопа.
    const bandH = Math.min(box.height, Math.round(265 / currentMmPerPx))
    if (bandH >= 40 && bandH < box.height) {
      const rowMass: number[] = []
      for (let y = box.y; y < box.y + box.height; y++) {
        let n = 0
        for (let x = box.x; x < box.x + box.width; x++) {
          if (cand.mask.ucharPtr(y, x)[0] > 0) n++
        }
        rowMass.push(n)
      }
      let bestStart = 0
      let bestSum = -1
      for (let i = 0; i + bandH <= rowMass.length; i++) {
        let sum = 0
        for (let j = i; j < i + bandH; j++) sum += rowMass[j]
        if (sum > bestSum) {
          bestSum = sum
          bestStart = i
        }
      }
      const cut2 = t.track(cand.mask.clone())
      for (let y = 0; y < box.y + bestStart; y++) for (let x = 0; x < srcW; x++) cut2.ucharPtr(y, x)[0] = 0
      for (let y = box.y + bestStart + bandH; y < srcH; y++) for (let x = 0; x < srcW; x++) cut2.ucharPtr(y, x)[0] = 0
      let bandBest: FootCandidate | null = null
      for (const c of collectFootCandidates(cv, cut2, srcW, srcH, frameArea, t, undefined, false, false)) {
        if (!bandBest || c.rank > bandBest.rank) bandBest = c
      }
      if (!bandBest && sizeGateEnabled) {
        sizeGateEnabled = false
        for (const c of collectFootCandidates(cv, cut2, srcW, srcH, frameArea, t, undefined, false, false)) {
          if (!bandBest || c.rank > bandBest.rank) bandBest = c
        }
        sizeGateEnabled = true
      }
      if (bandBest) {
        bandBest.rank = Math.max(bandBest.rank, rankCutPart(cv, bandBest.contour, bandBest.area, bandBest.borderTouch, frameArea, srcH))
        dbg?.onInfo?.('band_cut', { startRow: box.y + bestStart, bandH, rank: bandBest.rank })
        return bandBest
      }
    }
  }
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
  if (cutIdx < 0 && currentView === 'side') {
    // Стратегия для side: профиль «нога+стопа» не даёт сужения снизу (подошва
    // — тонкая линия). Режем НАД строкой максимальной ширины: голень уже
    // тела стопы, носок уже — оставляем массу ниже.
    let maxW = 0
    let maxIdx = 0
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] > maxW) {
        maxW = widths[i]
        maxIdx = i
      }
    }
    if (maxIdx > widths.length * 0.2 && maxIdx < widths.length * 0.85) {
      cutIdx = maxIdx
    }
  }
  if (cutIdx < 0) return null // сужения нет — это и есть стопа
  // Срез, оставляющий меньше четверти высоты, — артефакт, а не щиколотка.
  const maxCutFrac = currentView === "side" ? 0.85 : 0.75
  if (cutIdx > widths.length * maxCutFrac) return null
  dbg?.onInfo?.('leg_split_cut', { cutRow: box.y + cutIdx, footW: Math.round(footW), widthAtCut: Math.round(widths[cutIdx]) })

  // Обрезаем маску выше шеи.
  const cut = t.track(cand.mask.clone())
  const cutRow = box.y + cutIdx
  for (let y = 0; y < cutRow; y++) for (let x = 0; x < srcW; x++) cut.ucharPtr(y, x)[0] = 0

  // Крупнейшая компоненте ниже среза — стопа.
  let best: FootCandidate | null = null
  for (const c of collectFootCandidates(cv, cut, srcW, srcH, frameArea, t, undefined, false, false)) {
    if (!best || c.rank > best.rank) best = c
  }
  if (!best && sizeGateEnabled) {
    sizeGateEnabled = false
    for (const c of collectFootCandidates(cv, cut, srcW, srcH, frameArea, t, undefined, false, false)) {
      if (!best || c.rank > best.rank) best = c
    }
    sizeGateEnabled = true
  }
  if (best) {
    best.rank = Math.max(best.rank, rankCutPart(cv, best.contour, best.area, best.borderTouch, frameArea, srcH))
  }
  dbg?.onInfo?.('leg_split_result', { rank: best?.rank ?? null, areaPct: best ? Math.round((best.area / frameArea) * 1000) / 10 : null })
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

  // Две стратегии: вертикальный срез по боковой впадине (тапок рядом) и
  // горизонтальный по верхней впадине (нога, идущая в стопу по диагонали).
  let bestCutX = -1
  let bestDepth = 50 // минимальная глубина, px
  let bestCutY = -1
  let bestDepthY = 30
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
    // Верхняя впадина — прирост ноги (только top-ракурс).
    if (currentView === 'top' && yRel < 0.5 && depth > bestDepthY) {
      bestDepthY = depth
      bestCutY = pf[1]
    }
  }

  const collectBest = (keep: CvMat): FootCandidate | null => {
    let b: FootCandidate | null = null
    for (const c of collectFootCandidates(cv, keep, srcW, srcH, frameArea, t, dbg, false)) {
      if (!b || c.rank > b.rank) b = c
    }
    if (!b && sizeGateEnabled) {
      sizeGateEnabled = false
      for (const c of collectFootCandidates(cv, keep, srcW, srcH, frameArea, t, dbg, false)) {
        if (!b || c.rank > b.rank) b = c
      }
      sizeGateEnabled = true
    }
    if (b) {
      b.rank = Math.max(b.rank, rankCutPart(cv, b.contour, b.area, b.borderTouch, frameArea, srcH))
    }
    return b
  }

  let result: FootCandidate | null = null
  if (bestCutX >= 0) {
    dbg?.onInfo?.('side_split', { cutX: bestCutX, depth: Math.round(bestDepth) })
    const leftMask = t.track(cand.mask.clone())
    for (let y = 0; y < srcH; y++) for (let x = bestCutX; x < srcW; x++) leftMask.ucharPtr(y, x)[0] = 0
    const rightMask = t.track(cand.mask.clone())
    for (let y = 0; y < srcH; y++) for (let x = 0; x < bestCutX; x++) rightMask.ucharPtr(y, x)[0] = 0
    const leftArea = cv.countNonZero(leftMask)
    const rightArea = cv.countNonZero(rightMask)
    const keep = leftArea >= rightArea ? leftMask : rightMask
    result = collectBest(keep)
  }
  if (bestCutY >= 0) {
    dbg?.onInfo?.('top_split', { cutY: bestCutY, depth: Math.round(bestDepthY) })
    const lowMask = t.track(cand.mask.clone())
    for (let y = 0; y < bestCutY; y++) for (let x = 0; x < srcW; x++) lowMask.ucharPtr(y, x)[0] = 0
    const hiMask = t.track(cand.mask.clone())
    for (let y = bestCutY; y < srcH; y++) for (let x = 0; x < srcW; x++) hiMask.ucharPtr(y, x)[0] = 0
    const lowArea = cv.countNonZero(lowMask)
    const hiArea = cv.countNonZero(hiMask)
    const keep = lowArea >= hiArea ? lowMask : hiMask
    const r2 = collectBest(keep)
    // Защита от ложных срезов: оставшаяся часть должна быть стопоподобной
    // по aspect и заметно меньше исходника.
    if (r2) {
      const rb = cv.boundingRect(r2.contour)
      const rAspect = Math.max(rb.width, rb.height) / Math.max(1, Math.min(rb.width, rb.height))
      const removed = cand.area > 0 && r2.area <= cand.area * 0.85
      if (rAspect >= 1.8 && removed && (!result || r2.rank > result.rank)) result = r2
    }
  }
  return result
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
  kernelGrow: CvMat,
  srcW: number,
  srcH: number,
  frameArea: number,
  t: MatTracker,
  dbg?: FootDebug
): FootCandidate | null {
  if (!cand.fullMask) return null
  // Мягкий возврат размера: ядро меньше эрозии — мосты не восстанавливаются.
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
 * Ректификация точек контура в миллиметры плоскости эталона.
 * Гомография по 4 углам листа убирает перспективу/форшортенинг —
 * иначе стопа, направленная от камеры, занижается на cos(угол).
 * Возвращает точки в мм или null (квад без 4 реальных углов).
 */
function rectifyToReferencePlane(
  cv: Cv,
  quad: Quad,
  shortMm: number,
  longMm: number,
  pts: FootContourPoint[],
  t: MatTracker
): FootContourPoint[] | null {
  if (!quad.isPoly || quad.pts.length !== 4) return null
  // Упорядочить углы: c0c1 — короткая сторона, c1c2 — длинная.
  const P = quad.pts
  const sd = [0, 1, 2, 3].map((i) => dist(P[i].x, P[i].y, P[(i + 1) % 4].x, P[(i + 1) % 4].y))
  const order: FootContourPoint[] = []
  // Найти старт, с которого чередование короткая→длинная
  let start = 0
  for (let i = 0; i < 4; i++) {
    const a = sd[i]
    const b = sd[(i + 1) % 4]
    const c = sd[(i + 2) % 4]
    if (a < b && c < b && a < sd[(i + 3) % 4]) {
      start = i
      break
    }
  }
  for (let k = 0; k < 4; k++) order.push(P[(start + k) % 4])
  // Если первая сторона оказалась длинной — сдвиг на одну вершину.
  const ord =
    dist(order[0].x, order[0].y, order[1].x, order[1].y) > dist(order[1].x, order[1].y, order[2].x, order[2].y)
      ? [order[1], order[2], order[3], order[0]]
      : order

  const src = t.track(cv.matFromArray(4, 1, cv.CV_32FC2, ord.flatMap((q) => [q.x, q.y])))
  const dst = t.track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, shortMm, 0, shortMm, longMm, 0, longMm]))
  const H = t.track(cv.getPerspectiveTransform(src, dst))
  const inPts = t.track(cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flatMap((q) => [q.x, q.y])))
  const out = t.track(new cv.Mat())
  cv.perspectiveTransform(inPts, out, H)
  const res: FootContourPoint[] = []
  for (let i = 0; i < out.rows; i++) {
    const q = out.floatPtr(i, 0) as ArrayLike<number>
    res.push({ x: q[0], y: q[1] })
  }
  return res
}

/**
 * Продление пятки вдоль оси стопы до границы «не пол» (манжета джинсов).
 * Носок частично закрыт брючиной — видимый контур обрезан по узорной части.
 * Маршируем от обоих концов оси, берём конец, где быстро встречается
 * не-паркет (не тёплый яркий пиксель). Возвращает точки-продления.
 */
function extendHeelAlongAxis(
  src: CvMat,
  hullPts: FootContourPoint[],
  maxExtFrac: number
): FootContourPoint[] {
  if (hullPts.length < 4) return []
  // Ось: пара с максимальным расстоянием.
  let bi = 0
  let bj = 0
  let best = 0
  for (let i = 0; i < hullPts.length; i++) {
    for (let j = i + 1; j < hullPts.length; j++) {
      const d = dist(hullPts[i].x, hullPts[i].y, hullPts[j].x, hullPts[j].y)
      if (d > best) {
        best = d
        bi = i
        bj = j
      }
    }
  }
  if (best < 30) return []
  const maxExt = Math.min(90, best * maxExtFrac)
  const isFloor = (x: number, y: number): boolean => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || xi >= src.cols || yi < 0 || yi >= src.rows) return false
    const q = src.ucharPtr(yi, xi) as ArrayLike<number>
    const r = q[0]
    const g = q[1]
    const b = q[2]
    // тёплый яркий (паркет/ламинат)
    return r > 110 && r >= g && g >= b && r - b > 18
  }
  const march = (from: FootContourPoint, ux: number, uy: number): number => {
    // Пересекаем ОДНУ узкую не-полосу (белые резинки носка, ~до 45px)
    // и останавливаемся у начала широкой (манжета джинсов) — это пятка.
    let bandStart = -1
    for (let t = 6; t <= maxExt; t += 2) {
      const floor = isFloor(from.x + ux * t, from.y + uy * t)
      if (!floor && bandStart < 0) bandStart = t
      if (floor && bandStart >= 0) {
        const w = t - bandStart
        if (w <= 45) return Math.min(bandStart + 45, maxExt) // резинки → до манжеты
        return 0 // сразу широкий объект — продлевать нечего
      }
    }
    // До конца дистанции не вышли на пол: полоса упирается в объект.
    return bandStart >= 0 ? Math.min(bandStart + 45, maxExt) : 0
  }
  const ux = (hullPts[bj].x - hullPts[bi].x) / best
  const uy = (hullPts[bj].y - hullPts[bi].y) / best
  const extA = march(hullPts[bi], ux, uy)
  const extB = march(hullPts[bj], -ux, -uy)
  const out: FootContourPoint[] = []
  if (extA > 10) out.push({ x: Math.round(hullPts[bi].x + ux * extA), y: Math.round(hullPts[bi].y + uy * extA) })
  if (extB > 10) out.push({ x: Math.round(hullPts[bj].x - ux * extB), y: Math.round(hullPts[bj].y - uy * extB) })
  return out
}

/** Геометрия side-кандидата: hull, длина (max pairwise), instepPx и ratio
 * (высота над МНК-линией пола по нижним 7% bbox / длина). Для fallback-перебора. */
function sideGeometry(
  cv: Cv,
  cand: FootCandidate,
  t: MatTracker
): { ratio: number; instepPx: number; lengthPx: number; hullPts: FootContourPoint[] } | null {
  const hull = t.track(new cv.Mat())
  cv.convexHull(cand.contour, hull, false, true)
  const hullPts = contourPoints(hull)
  if (hullPts.length < 3) return null
  let lengthPx = 0
  for (let i = 0; i < hullPts.length; i++) {
    for (let j = i + 1; j < hullPts.length; j++) {
      const d = dist(hullPts[i].x, hullPts[i].y, hullPts[j].x, hullPts[j].y)
      if (d > lengthPx) lengthPx = d
    }
  }
  if (lengthPx <= 0) return null
  const box = cv.boundingRect(cand.contour)
  const floorBand = box.y + box.height * 0.93
  let sx = 0
  let sy = 0
  let n = 0
  for (const p of hullPts) {
    if (p.y >= floorBand) {
      sx += p.x
      sy += p.y
      n++
    }
  }
  let instepPx = 0
  if (n >= 3) {
    const mx = sx / n
    const my = sy / n
    let sxy = 0
    let sxx = 0
    for (const p of hullPts) {
      if (p.y >= floorBand) {
        sxy += (p.x - mx) * (p.y - my)
        sxx += (p.x - mx) * (p.x - mx)
      }
    }
    const k = sxx > 1 ? sxy / sxx : 0
    const b = my - k * mx
    const denom = Math.sqrt(k * k + 1)
    for (const p of hullPts) {
      const d = (b + k * p.x - p.y) / denom // >0 выше линии (y вниз)
      if (d > instepPx) instepPx = d
    }
  } else {
    instepPx = Math.max(...hullPts.map((p) => p.y)) - Math.min(...hullPts.map((p) => p.y))
  }
  return { ratio: instepPx / lengthPx, instepPx, lengthPx, hullPts }
}

/**
 * Измеряет стопу по фото.
 * @returns замер; эталон и стопа ищутся независимо — см. флаги referenceFound/footFound.
 * @param debug опциональный колбэк для дампа промежуточных масок (харнесс).
 */
export function measureFoot(imageData: ImageData, options?: MeasureOptions, debug?: FootDebug): FootMeasurement {
  const view: FootView = options?.view ?? 'top'
  currentView = view
  allCandidates = []
  const cv = getOpenCv()
  const t = new MatTracker()
  try {
    const src = t.track(cv.matFromImageData(imageData))
    const frameArea = src.rows * src.cols

    const gray = t.track(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    currentGray = gray
    frameMeanGray = (cv.mean(gray) as unknown as ArrayLike<number>)[0]
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
    // Адаптивный Canny ТОЛЬКО для эталона: пороги от медианы gray — край листа
    // ловится независимо от его цвета (голубой лист на паркете при фикс 50/150
    // терялся). Остальные проходы продолжают с фикс-эджами (натюнены).
    const smallMed = t.track(new cv.Mat())
    cv.resize(blurred, smallMed, { width: 128, height: Math.max(1, Math.round((128 * blurred.rows) / blurred.cols)) }, 0, 0, cv.INTER_AREA)
    const medN = smallMed.rows * smallMed.cols
    const medVals: number[] = new Array(medN)
    for (let y = 0; y < smallMed.rows; y++) {
      for (let x = 0; x < smallMed.cols; x++) {
        medVals[y * smallMed.cols + x] = smallMed.ucharPtr(y, x)[0]
      }
    }
    medVals.sort((a, b) => a - b)
    const med = medVals[medN >> 1] ?? 128
    const lowTh = Math.max(10, Math.round(0.4 * med))
    const highTh = Math.min(255, Math.round(1.3 * med))
    const edgesRef = t.track(new cv.Mat())
    cv.Canny(blurred, edgesRef, lowTh, highTh)
    debug?.onInfo?.('ref_canny', { med: Math.round(med), low: lowTh, high: highTh })
    const reference = findReference(cv, edgesRef, blurred, frameArea, t, debug)
    activeRefBounds = reference ? quadBounds(reference.quad) : null
    currentMmPerPx = reference ? reference.mmPerPx : null
    // Ожидаемая площадь стопы (~265×115 мм, заполнение ~0.65) для ранжирования.
    expectedFootAreaPx = reference ? Math.round((0.65 * 265 * 115) / (reference.mmPerPx * reference.mmPerPx)) : null

    const hsv = t.track(new cv.Mat())
    cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB)
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV)
    currentHsv = hsv

    // --- Сегментация стопы ---
    // Размеры ядер — адаптивные: на маленьких кадрах крупная эрозия
    // уничтожает саму стопу (носок 100px против кадра 720px).
    const minDim = Math.min(src.cols, src.rows)
    const odd = (n: number) => Math.max(3, Math.round(n) | 1)
    const erodeSize = Math.min(45, Math.max(15, odd(minDim * 0.029)))
    const growSize = Math.max(7, odd(minDim * 0.012))
    const borderStrip = Math.max(8, Math.round(minDim * 0.01))
    // Close адаптивен: лечит дырки текстуры (жаккард носка), но меньше
    // типичных зазоров к соседним объектам (~3% кадра) — мосты не срастаются.
    const closeSize = Math.min(13, Math.max(7, odd(minDim * 0.014)))
    const kernel = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeSize, closeSize)))
    const kernelSmall = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)))
    const kernelErode = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(erodeSize, erodeSize)))
    const kernelGrow = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(growSize, growSize)))
    const thresh = t.track(new cv.Mat())
    const morph = t.track(new cv.Mat())
    const morph2 = t.track(new cv.Mat())
    const morphHoles = t.track(new cv.Mat())

    let foot: FootCandidate | null = null
    let nnCandidate: FootCandidate | null = null
    const consider = (binary: CvMat, label: string): FootCandidate | null => {
      // Мягкий open (3×3) не разрушает текстуру носка, close лечит разрывы.
      // ВАЖНО: in-place morphologyEx/erode в opencv-js — частичный no-op,
      // каждая операция пишет в отдельный Mat.
      cv.morphologyEx(binary, morph, cv.MORPH_OPEN, kernelSmall)
      cv.morphologyEx(morph, morph2, cv.MORPH_CLOSE, kernel)
      // Обрезаем полосу у границ кадра: цепочки тёмных объектов вдоль края
      // (штаны → тапок → паркет) иначе сливаются в один бесполезный блоб.
      stripBorders(cv, morph2, borderStrip)
      // Полная маска прохода — база для реконструкции после эрозии.
      const fullMask = t.track(morph2.clone())
      // Эрозия разрывает тонкие мосты к посторонним тёмным объектам.
      cv.erode(morph2, morph, kernelErode)
      debug?.onMask(label, morph)
      let best: FootCandidate | null = null
      let n = 0
      for (const cand of collectFootCandidates(cv, morph, src.cols, src.rows, frameArea, t, debug)) {
        cand.fullMask = fullMask
        n++
        if (!best || cand.rank > best.rank) best = cand
      }
      debug?.onInfo?.('consider', { label, candidates: n, bestRank: best?.rank ?? null })
      // Fallback: размерный gate мог отсеять всех (редкий масштаб эталона).
      if (!best && sizeGateEnabled) {
        sizeGateEnabled = false
        for (const cand of collectFootCandidates(cv, morph, src.cols, src.rows, frameArea, t, debug)) {
          cand.fullMask = fullMask
          if (!best || cand.rank > best.rank) best = cand
        }
        sizeGateEnabled = true
      }
      return best
    }
    // Тёмные объекты на светлом фоне: берём ДЫРКИ bright-маски (тёмный остров
    // внутри светлого — носок на паркете). Рамка/UI снаружи светлой области в
    // дырки не попадают — гигантской связки тут не бывает. Слоты жаккардового
    // узора сливаем close в единый блоб.
    const healSize = Math.min(45, Math.max(9, odd(minDim * 0.05)))
    const kernelHeal = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(healSize, healSize)))
    const considerHoles = (binary: CvMat): FootCandidate | null => {
      cv.morphologyEx(binary, morphHoles, cv.MORPH_OPEN, kernelSmall)
      cv.morphologyEx(morphHoles, morph2, cv.MORPH_CLOSE, kernel)
      stripBorders(cv, morph2, borderStrip)
      // Собираем маску из дырок.
      const hContours = t.track(new cv.MatVector())
      const hHier = t.track(new cv.Mat())
      cv.findContours(morph2, hContours, hHier, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)
      const holesMask = t.track(cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1))
      for (let i = 0; i < hContours.size(); i++) {
        const h = hHier.intPtr(0, i) as ArrayLike<number>
        if (h[3] === -1) continue // только дырки
        cv.drawContours(holesMask, hContours, i, new cv.Scalar(255), cv.FILLED)
        // Дочерние островки (белые резинки носка внутри дырки) — вернуть
        // в силуэт, иначе контур обрезается по узорной части.
        let child = h[2]
        while (child !== -1) {
          cv.drawContours(holesMask, hContours, child, new cv.Scalar(255), cv.FILLED)
          child = (hHier.intPtr(0, child) as ArrayLike<number>)[0]
        }
      }
      cv.morphologyEx(holesMask, morphHoles, cv.MORPH_CLOSE, kernelHeal)
      debug?.onMask('2b_dark_on_bright', morphHoles)
      const brightMask = t.track(morph2.clone())
      let best: FootCandidate | null = null
      let n = 0
      for (const cand of collectFootCandidates(cv, morphHoles, src.cols, src.rows, frameArea, t, debug, true, true, true)) {
        cand.fullMask = morphHoles
        cand.isHole = true
        cand.auxMask = brightMask
        n++
        if (!best || cand.rank > best.rank) best = cand
      }
      debug?.onInfo?.('consider', { label: '2b_dark_on_bright', candidates: n, bestRank: best?.rank ?? null })
      if (!best && sizeGateEnabled) {
        sizeGateEnabled = false
        for (const cand of collectFootCandidates(cv, morphHoles, src.cols, src.rows, frameArea, t, debug, true, true, true)) {
          cand.fullMask = morphHoles
          if (!best || cand.rank > best.rank) best = cand
        }
        sizeGateEnabled = true
      }
      return best
    }
    const notBrightFull = t.track(new cv.Mat())
    {
      const threshBright = t.track(new cv.Mat())
      cv.threshold(blurredBig, threshBright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
      const mb = t.track(new cv.Mat())
      cv.medianBlur(threshBright, mb, 5)
      cv.bitwise_not(mb, notBrightFull)
      foot = betterCandidate(foot, considerHoles(threshBright))
    }

    if (!foot || foot.rank < 1.5) {
      for (const inv of [false, true]) {
        const flag = (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU
        cv.threshold(blurredBig, thresh, 0, 255, flag)
        foot = betterCandidate(foot, consider(thresh, inv ? '3_binary_dark' : '2_binary_bright'))
      }
    }
    // Третий источник: kmeans-разделение яркости (тёмный класс),
    // минус «тёплые» пиксели (паркет, доски, кожа) — иначе тёмный пол
    // слипается с носком и раздувает контур.
    const km = foot && foot.rank >= 1.5 ? null : kmeansDarkMask(cv, blurredBig, t)
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
      foot = betterCandidate(foot, consider(cool, '3b_kmeans_dark'))
    }

    // Пятый источник: тёмный холодный насыщенный (носок navy).
    // Джинсы исключены по V (яркие), безель/UI по S (не насыщенные).
    // Крупный close срастает полосы жаккарда в единый блоб.
    if (!foot || foot.rank < 1.5) {
      const coolDark = t.track(new cv.Mat())
      const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [80, 35, 0, 0])
      const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [150, 255, 158, 0])
      cv.inRange(hsv, lo, hi, coolDark)
      lo.delete()
      hi.delete()
      cv.morphologyEx(coolDark, morph2, cv.MORPH_CLOSE, kernelHeal)
      // Залить мелкие дырки (белые резинки носка внутри блоба).
      {
        const cContours = t.track(new cv.MatVector())
        const cHier = t.track(new cv.Mat())
        cv.findContours(morph2, cContours, cHier, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)
        for (let i = 0; i < cContours.size(); i++) {
          const ch = cHier.intPtr(0, i) as ArrayLike<number>
          if (ch[3] === -1) continue
          const ca = Math.abs(cv.contourArea(cContours.get(i)))
          if (ca > 0 && ca < frameArea * 0.25) {
            cv.drawContours(morph2, cContours, i, new cv.Scalar(255), cv.FILLED)
          }
        }
      }
      foot = betterCandidate(foot, consider(morph2, '3c_cooldark'))
    }

    if (!foot || foot.rank < 1.5) {
      // Шестой источник: кольца Canny-эджей (БЕЗ эрозии — кольцо тонкое).
      // Босая стопа на солнечном паркете яркостно не отделяется (сливается с
      // полом в гигантский блоб), но контур стопы — замкнутое кольцо эджей.
      {
        const edgeK = t.track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15)))
        const edgeClosed = t.track(new cv.Mat())
        cv.morphologyEx(edges, edgeClosed, cv.MORPH_CLOSE, edgeK)
        stripBorders(cv, edgeClosed, borderStrip)
        debug?.onMask('4_edge_rings', edgeClosed)
        let edgeBest: FootCandidate | null = null
        let edgeCount = 0
        // checkRef=false: тонкое кольцо стопы может лежать прямо над листом —
        // точки контура попадают в его прямоугольник. Кольцо самого листа —
        // прямоугольник, ранкинг (extent) его отсекает.
        for (const cand of collectFootCandidates(cv, edgeClosed, src.cols, src.rows, frameArea, t, debug, true, false)) {
          cand.fullMask = edgeClosed
          edgeCount++
          edgeBest = betterCandidate(edgeBest, cand)
        }
        if (!edgeBest && sizeGateEnabled) {
          // Fallback без размерного gate и без ref-exclusion (см. выше).
          sizeGateEnabled = false
          for (const cand of collectFootCandidates(cv, edgeClosed, src.cols, src.rows, frameArea, t, debug, true, false)) {
            cand.fullMask = edgeClosed
            edgeCount++
            edgeBest = betterCandidate(edgeBest, cand)
          }
          sizeGateEnabled = true
        }
        debug?.onInfo?.('consider', { label: '4_edge_rings', candidates: edgeCount, bestRank: edgeBest?.rank ?? null })
        // Кольца — fallback-only: на скриншотах находят кольца UI-элементов и
        // обыгрывают реальную стопу. Используем, только если нормальные маски
        // никого не дали.
        if (edgeBest) {
          foot = betterCandidate(foot, edgeBest)
          debug?.onInfo?.('edge_fallback', { rank: edgeBest.rank, areaPct: Math.round((edgeBest.area / frameArea) * 1000) / 10 })
        }
      }

    }

    // === Источник 0: NN-маска «человек/фон» (основной) ===
    // person = 2|3|4. Если дала адекватного кандидата — классические пороговые
    // проходы не запускаем (быстрее и стабильнее).
    const personMaskOpt = options?.personMask
    if (personMaskOpt && personMaskOpt.mask.length >= personMaskOpt.width * personMaskOpt.height) {
      const pmW = personMaskOpt.width
      const pmH = personMaskOpt.height
      // person = 2|3|4. Собираем в JS-массив и одним matFromArray — запись
      // через миллион ucharPtr портит соседнюю wasm-память (см. баг с in-place).
      const personArr = new Uint8Array(pmW * pmH)
      for (let i = 0; i < pmW * pmH; i++) {
        const v = personMaskOpt.mask[i]
        if (v === 2 || v === 3 || v === 4) personArr[i] = 255
      }
      const person = t.track(cv.matFromArray(pmH, pmW, cv.CV_8UC1, Array.from(personArr)))
      // Масштаб до размеров кадра (nearest), если отличается.
      let personFull: CvMat = person
      if (pmW !== src.cols || pmH !== src.rows) {
        const scaled = t.track(new cv.Mat())
        cv.resize(person, scaled, { width: src.cols, height: src.rows }, 0, 0, cv.INTER_NEAREST)
        personFull = scaled
      }
      // Морфология в отдельные dst и отдельные mats (in-place — no-op в opencv.js;
      // общие morph/morph2 не трогаем, чтобы не влиять на классические проходы).
      const nnMorphA = t.track(new cv.Mat())
      const nnMorphB = t.track(new cv.Mat())
      cv.morphologyEx(personFull, nnMorphA, cv.MORPH_OPEN, kernelSmall)
      cv.morphologyEx(nnMorphA, nnMorphB, cv.MORPH_CLOSE, kernel)
      stripBorders(cv, nnMorphB, borderStrip)
      debug?.onMask('0_person_nn', nnMorphB)
      let nnBest: FootCandidate | null = null
      const nnCands = collectFootCandidates(cv, nnMorphB, src.cols, src.rows, frameArea, t, debug)
      if (!nnCands.length && sizeGateEnabled) {
        sizeGateEnabled = false
        for (const c of collectFootCandidates(cv, nnMorphB, src.cols, src.rows, frameArea, t, debug)) nnCands.push(c)
        sizeGateEnabled = true
      }
      // Стопа — крупнейшая компонента у нижнего конца маски (bottom в пределах
      // 15% от самого нижнего пикселя силуэта).
      let nnBottomY = -1
      for (const c of nnCands) {
        c.fullMask = nnMorphB
        if (c.area < frameArea * 0.005) continue
        const b = cv.boundingRect(c.contour)
        if (b.y + b.height > nnBottomY) nnBottomY = b.y + b.height
      }
      for (const c of nnCands) {
        if (c.area < frameArea * 0.005) continue
        const b = cv.boundingRect(c.contour)
        if (b.y + b.height < nnBottomY - src.rows * 0.15) continue
        if (!nnBest || c.area > nnBest.area) nnBest = c
      }
      if (nnBest) {
        // Размерный gate заточен под классику; силуэт «нога+стопа» от NN
        // может быть крупнее ожидания.
        sizeGateEnabled = false
      }
      // NN доверенная: принимаем по площади (классические shape-эвристики
      // типа extent ломаются на сплошном силуэте «нога+стопа»).
      if (nnBest && nnBest.area > frameArea * 0.005 && nnBest.area < frameArea * 0.6) {
        nnBest.rank = Math.max(nnBest.rank, 3) + 1.5
        nnBest.isNN = true
        nnCandidate = nnBest
        debug?.onInfo?.('nn_chosen', { rank: Math.round(nnBest.rank * 100) / 100, areaPct: Math.round((nnBest.area / frameArea) * 1000) / 10 })
      }
    }

    // Отрезаем боковые приросты (предметы рядом с пяткой/носком) и ногу
    // сверху (диагональный вход голени в top-ракурсе).
    if (foot) {
      const splitC = splitSideAttachment(cv, foot, src.cols, src.rows, frameArea, t, debug)
      if (splitC && splitC.rank >= foot.rank) foot = splitC
    }
    // Вертикальный срез столба ноги (NN-силуэт «нога+стопа» в top).
    if (foot && currentView === 'top') {
      const fb = cv.boundingRect(foot.contour)
      const fAspect = Math.max(fb.width, fb.height) / Math.max(1, Math.min(fb.width, fb.height))
      debug?.onInfo?.('colcut_entry', { fAspect: Math.round(fAspect * 100) / 100 })
      if (fAspect < 2.6) {
        const colCut = cutLegColumn(cv, foot, src.cols, src.rows, frameArea, t, debug)
        // NN-силуэт доверенный: срез голени принимаем даже при низком rank
        // (позиционные эвристики ломаются на стопе в верхней части кадра).
        if (colCut && (colCut.rank >= foot.rank || (foot.isNN && colCut.area > frameArea * 0.03))) foot = colCut
      }
    }

    // Изолированная маленькая стопа на светлом фоне (носок, контур строго
    // по тёмному) короче анатомической: расширяем в прилегающую тёмную одежду
    // у щиколотки — дилатация + пересечение с тёмной частью кадра.
    // Ограничения: top-view, area < 3% кадра, без касания границ (иначе это
    // крупные сцены 12-xx или обрезки у края — там расширение вредно).
    if (view === 'top' && foot && foot.area < frameArea * 0.03 && foot.borderTouch < 0.02) {
      const growK = Math.min(45, Math.max(15, odd(minDim * 0.06)))
      const kernelExtend = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(growK, growK)))
      const dilated = t.track(new cv.Mat())
      cv.dilate(foot.mask, dilated, kernelExtend)
      const addition = t.track(new cv.Mat())
      cv.bitwise_and(dilated, notBrightFull, addition)
      const grownMask = t.track(new cv.Mat())
      cv.bitwise_or(foot.mask, addition, grownMask)
      const grownCands = collectFootCandidates(cv, grownMask, src.cols, src.rows, frameArea, t, undefined, false)
      for (const c of grownCands) {
        if (c.area >= foot.area * 0.95) {
          foot = c
          break
        }
      }
    }

    // Отрезаем голень по «щиколотке», если она попала в кадр.
    if (foot) {
      debug?.onMask('4_foot_raw', foot.mask)
      const cut = splitFootFromLeg(cv, foot, src.cols, src.rows, frameArea, t, debug)
      if (cut && cut.rank > foot.rank) foot = cut
    }

    // Реконструкция: отделяем стопу от слипшихся тёмных объектов.
    if (foot) {
      const reconstructed = reconstructFoot(cv, foot, kernelGrow, src.cols, src.rows, frameArea, t, debug)
      if (reconstructed && reconstructed.rank > foot.rank) foot = reconstructed
    }
    activeRefBounds = null
    expectedFootAreaPx = null
    debug?.onMask('5_foot_final', foot?.mask ?? morph)
    debug?.onInfo?.('expected_area', { expected: expectedFootAreaPx, frameArea })
    debug?.onInfo?.('foot_chosen', foot ? { rank: foot.rank, areaPct: Math.round((foot.area / frameArea) * 1000) / 10, touch: Math.round(foot.borderTouch * 100) / 100, isHole: !!foot.isHole } : { none: true })

    const empty: FootMeasurement = {
      view,
      lengthMm: null,
      widthMm: null,
      instepHeightMm: null,
      instepRatio: null,
      ballWidthMm: null,
      footContour: [],
      referenceFound: reference !== null,
      footFound: foot !== null && foot.rank >= 1.5,
      referenceKind: reference?.kind ?? null,
      sockDetected: false
    }

    // Арбитраж NN vs классика: NN — основной источник, но при большом
    // расхождении длин (и правдоподобной классике) доверяем проверенной
    // классике — NN-силуэт почти всегда включает голень.
    if (nnCandidate && foot && nnCandidate !== foot && reference) {
      const hullMax = (cand: FootCandidate): number => {
        const h = t.track(new cv.Mat())
        cv.convexHull(cand.contour, h, false, true)
        const pts = contourPoints(h)
        let m = 0
        for (let i = 0; i < pts.length; i++)
          for (let j = i + 1; j < pts.length; j++) m = Math.max(m, dist(pts[i].x, pts[i].y, pts[j].x, pts[j].y))
        return m
      }
      const nnMm = hullMax(nnCandidate) * reference.mmPerPx
      const clMm = hullMax(foot) * reference.mmPerPx
      const plausible = (v: number) => v >= 200 && v <= 340
      // Расхождение: включённая в силуэт голень только РАЗДУВАЕТ длину —
      // чистый контур стопы короче. Берём более короткого (если оба правдоподобны).
      const bothPlausible = plausible(clMm) && plausible(nnMm)
      if ((plausible(clMm) && !plausible(nnMm)) || (bothPlausible && Math.abs(nnMm - clMm) / Math.max(nnMm, clMm) > 0.12 && nnMm > clMm)) {
        debug?.onInfo?.('arbitration', { nnMm: Math.round(nnMm), clMm: Math.round(clMm), picked: 'classic' })
        // foot уже классика — оставляем
      } else {
        debug?.onInfo?.('arbitration', { nnMm: Math.round(nnMm), clMm: Math.round(clMm), picked: 'nn' })
        foot = nnCandidate
      }
    }

    // Носок: считаем по ВЫБРАННОЙ компоненте стопы, а не по нижней трети
    // всей маски — иначе джинсы (класс 4) ниже стопы дают ложное
    // срабатывание на босой ноге. Носок = внутри компоненты мало кожи
    // (2|3) и одежда (4) доминирует; босая стопа/голень дают много кожи.
    const pm = options?.personMask
    if (pm && pm.mask.length >= pm.width * pm.height && foot && pm.width === src.cols && pm.height === src.rows) {
      const box = cv.boundingRect(foot.contour)
      const compRoi = t.track(foot.mask.roi(new cv.Rect(box.x, box.y, box.width, box.height)))
      const total = cv.countNonZero(compRoi)
      if (total >= 500) {
        // Маски классов строим только внутри bbox. ucharPtr-скаляр на
        // каждый пиксель — медленно; математика в cv + JS-сбор массива.
        const mkClass = (pred: (v: number) => boolean) => {
          const arr = new Uint8Array(box.width * box.height)
          for (let y = 0; y < box.height; y++) {
            const off = (box.y + y) * pm.width + box.x
            const ro = y * box.width
            for (let x = 0; x < box.width; x++) if (pred(pm.mask[off + x])) arr[ro + x] = 255
          }
          return t.track(cv.matFromArray(box.height, box.width, cv.CV_8UC1, Array.from(arr)))
        }
        const skinM = mkClass((v) => v === 2 || v === 3)
        const clothesM = mkClass((v) => v === 4)
        const andM = t.track(new cv.Mat())
        cv.bitwise_and(compRoi, skinM, andM)
        const skin = cv.countNonZero(andM)
        cv.bitwise_and(compRoi, clothesM, andM)
        const clothes = cv.countNonZero(andM)
        debug?.onInfo?.('sock', { total, skin, clothes })
        // Основной порог: одежда доминирует. Доп. ветка: кожи нет совсем,
        // а одежда заметна — NN часто маркирует тёмный носок как «фон», тогда
        // доля 4 ниже основного порога, но носок всё равно очевиден.
        const skinFrac = skin / total
        const clothesFrac = clothes / total
        if (skinFrac < 0.15 && (clothesFrac >= 0.4 || (skin === 0 && clothesFrac >= 0.15))) {
          empty.sockDetected = true
        }
      }
    }

    if (!foot || !empty.footFound) return empty

    // Контур стопы (упрощённый hull). Вершины у левого/правого края кадра
    // отбрасываем: это срезы объекта рамкой или прилипшие предметы (тапок).
    const hull = t.track(new cv.Mat())
    cv.convexHull(foot.contour, hull, false, true)
    const allHullPts = contourPoints(hull)
    // Обрезка вершин у боковых краёв — только для top (срезы рамкой/тапок).
    // В side стопа может легитимно упираться в края кадра.
    const xLo = 0.04 * src.cols
    const xHi = 0.96 * src.cols
    const trimmed = view === 'top' ? allHullPts.filter((p) => p.x >= xLo && p.x <= xHi) : allHullPts
    // Если обрезка съела почти весь контур (объект у края) — не обрезаем.
    const hullPts = trimmed.length >= 6 ? trimmed : allHullPts
    const step = Math.max(1, Math.floor(hullPts.length / 150))
    empty.footContour = hullPts.filter((_, i) => i % step === 0)

    // --- Общая метрика: длина (max pairwise по hull), кросс-проверка ракурсов ---
    let lengthPx = 0
    const pairs: Array<{ d: number; i: number; j: number }> = []
    for (let i = 0; i < hullPts.length; i++) {
      for (let j = i + 1; j < hullPts.length; j++) {
        const d = dist(hullPts[i].x, hullPts[i].y, hullPts[j].x, hullPts[j].y)
        pairs.push({ d, i, j })
        if (d > lengthPx) lengthPx = d
      }
    }
    // NN/силуэт «нога+стопа»: диагональ с голенью превышает реальную длину.
    // Берём самую длинную хорду в пределах правдоподобного бюджета (~300 мм).
    if (view === 'top' && currentMmPerPx && currentMmPerPx > 0) {
      const budgetPx = 300 / currentMmPerPx
      if (lengthPx > budgetPx) {
        pairs.sort((a, b) => b.d - a.d)
        const pick = pairs.find((p) => p.d <= budgetPx * 0.98)
        if (pick) {
          debug?.onInfo?.('chord_budget', { full: Math.round(lengthPx), picked: Math.round(pick.d) })
          lengthPx = pick.d
        }
      }
    }

    if (view === 'side') {
      // Side: эталон НЕ нужен. Лист на полу, снятый под углом — сплюснутая
      // трапеция, ratio-проверку не проходит. Считаем ОТНОСИТЕЛЬНЫЙ подъём:
      // высота контура над линией пола / длина контура (px). В мм переводит
      // footModel через длину из top-ракурса.
      let geom = sideGeometry(cv, foot, t)
      let ratio = geom ? geom.ratio : 0
      // Fallback: ratio вне 0.08–0.6 — выбранный кандидат, вероятно,
      // склеен с картой/листом (phone-side__card). Перебираем топ-3 остальных
      // по рангу и берём первого с правдоподобным подъёмом 0.12–0.5.
      if (!(ratio >= 0.08 && ratio <= 0.6)) {
        const alts = allCandidates
          .filter((c) => c !== foot && c.area >= frameArea * 0.005 && c.area <= frameArea * 0.7)
          .sort((a, b) => b.rank - a.rank)
          .slice(0, 3)
        for (const alt of alts) {
          const g = sideGeometry(cv, alt, t)
          debug?.onInfo?.('side_fallback', { rank: Math.round(alt.rank * 100) / 100, areaPct: Math.round((alt.area / frameArea) * 1000) / 10, ratio: g ? Math.round(g.ratio * 1000) / 1000 : null })
          if (g && g.ratio >= 0.12 && g.ratio <= 0.5) {
            geom = g
            ratio = g.ratio
            // Контура и длина — от принятого альтернативного кандидата.
            const astep = Math.max(1, Math.floor(g.hullPts.length / 150))
            empty.footContour = g.hullPts.filter((_, i) => i % astep === 0)
            lengthPx = g.lengthPx
            break
          }
        }
      }
      const instepPx = geom ? geom.instepPx : 0
      debug?.onInfo?.('side_debug', { instepPx: Math.round(instepPx), ratio: Math.round(ratio * 1000) / 1000 })
      if (ratio >= 0.08 && ratio <= 0.6) {
        empty.instepRatio = Math.round(ratio * 1000) / 1000
      }
      // Эталон найден (синтетика) — считаем и в мм для кросс-проверки.
      if (reference) {
        const lengthMmSide = lengthPx * reference.mmPerPx
        if (lengthMmSide >= 120 && lengthMmSide <= 360) {
          empty.lengthMm = Math.round(lengthMmSide * 10) / 10
          const instepMm = instepPx * reference.mmPerPx
          if (instepMm >= 30 && instepMm <= 200) {
            empty.instepHeightMm = Math.round(instepMm * 10) / 10
          }
        } else {
          debug?.onInfo?.('reference_rejected', { lengthMm: Math.round(lengthMmSide) })
          empty.referenceFound = false
          empty.referenceKind = null
        }
      }
      debug?.onInfo?.('result_fields', { view, instep: empty.instepHeightMm, ratio: empty.instepRatio, len: empty.lengthMm })
      return empty
    }

    if (!reference) return empty

    const lengthMm = lengthPx * reference.mmPerPx

    // Sanity-guard длины: нереальный размер => эталон скорее всего ложный.
    if (lengthMm < 120 || lengthMm > 360) {
      debug?.onInfo?.('reference_rejected', { lengthMm: Math.round(lengthMm) })
      empty.referenceFound = false
      empty.referenceKind = null
      return empty
    }
    empty.lengthMm = Math.round(lengthMm * 10) / 10
    if (view === 'top') {
      // Продление пятки до манжеты джинсов (носок обрезан брючиной).
      const extended = extendHeelAlongAxis(src, hullPts, 0.22)
      if (extended.length > 0) {
        hullPts.push(...extended)
        debug?.onInfo?.('heel_extend', { pts: extended.length })
      }
      // Ректификация в плоскость эталона (убирает перспективу).
      const refObj = REFERENCES.find((r) => r.kind === reference.kind)!
      const rectified = rectifyToReferencePlane(cv, reference.quad, refObj.shortMm, refObj.shortMm * refObj.ratio, hullPts, t)
      if (rectified && rectified.length >= 4) {
        let lenPx2 = 0
        let maxW = 0
        for (let i = 0; i < rectified.length; i++) {
          for (let j = i + 1; j < rectified.length; j++) {
            const d = dist(rectified[i].x, rectified[i].y, rectified[j].x, rectified[j].y)
            if (d > lenPx2) lenPx2 = d
          }
          // поперечник через точку: max расстояние до другой точки ~ ширина
        }
        // Ширина: minAreaRect по ректифицированным точкам (в мм).
        const rm = t.track(cv.matFromArray(rectified.length, 1, cv.CV_32FC2, rectified.flatMap((q) => [q.x, q.y])))
        const rrect = cv.minAreaRect(rm)
        maxW = Math.min(rrect.size.width, rrect.size.height)
        const lenR = lenPx2
        const widR = maxW
        debug?.onInfo?.('rectified', { len: Math.round(lenR), wid: Math.round(widR) })
        if (lenR >= 120 && lenR <= 360 && lenR > lengthMm * 0.85) {
          // Ректификация адекватна — берём её (длиннее = ближе к истине при наклоне).
          empty.lengthMm = Math.round(lenR * 10) / 10
          if (widR >= 40 && widR <= 320) {
            empty.widthMm = Math.round(Math.min(widR, lenR) * 10) / 10
          }
        } else if (widR >= 40 && widR <= 320) {
          empty.widthMm = Math.round(Math.min(widR, lengthMm) * 10) / 10
        }
      } else {
        const rect = cv.minAreaRect(foot.contour)
        const widthMm = Math.min(rect.size.width, rect.size.height) * reference.mmPerPx
        if (widthMm >= 40 && widthMm <= 320) {
          empty.widthMm = Math.round(Math.min(widthMm, lengthMm) * 10) / 10
        }
      }
    } else {
      // front: ширина переднего отдела — max ширина строки маски в более широкой
      // половине bbox (передний отдел шире пятки).
      const box = cv.boundingRect(foot.contour)
      const midY = box.y + box.height / 2
      const rowWidth = (from: number, to: number): number => {
        let best = 0
        for (let y = Math.max(0, from); y < Math.min(foot.mask!.rows, to); y++) {
          let x0 = -1
          let x1 = -1
          for (let x = 0; x < foot.mask!.cols; x++) {
            if (foot.mask!.ucharPtr(y, x)[0] > 0) {
              if (x0 < 0) x0 = x
              x1 = x
            }
          }
          if (x0 >= 0 && x1 - x0 > best) best = x1 - x0
        }
        return best
      }
      const topW = rowWidth(box.y, Math.floor(midY))
      const bottomW = rowWidth(Math.ceil(midY), box.y + box.height)
      const ballPx = Math.max(topW, bottomW)
      const ballMm = ballPx * reference.mmPerPx
      debug?.onInfo?.('front_debug', { ballPx, topW, bottomW, ballMm: Math.round(ballMm) })
      if (ballMm >= 60 && ballMm <= 200) {
        empty.ballWidthMm = Math.round(ballMm * 10) / 10
      }
    }
    debug?.onInfo?.('result_fields', { view, instep: empty.instepHeightMm, ball: empty.ballWidthMm, len: empty.lengthMm })
    return empty
  } finally {
    t.dispose()
  }
}
