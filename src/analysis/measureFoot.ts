// Измерение стопы по фото с калибровкой листом А4 (OpenCV.js).
//
// Пайплайн:
//  1. Поиск листа А4: Canny → findContours → approxPolyDP (4 вершины,
//     соотношение сторон ~1:1.414 с допуском на перспективу, площадь > 15% кадра).
//     Масштаб: средняя короткая сторона А4 = 210 мм.
//  2. Сегментация стопы: Otsu + morphologyEx, крупнейший внутренний контур,
//     не совпадающий с А4. Если стопа не найдена — fallback: второй по площади
//     контур из общего поиска.
//  3. Длина — максимальное попарное расстояние по convex hull,
//     ширина — малая сторона minAreaRect (rotatedRect).
//  4. Если А4 не найден — null (вызывающий код показывает подсказку).
import { getOpenCv } from './opencvLoader'

export interface FootContourPoint {
  x: number
  y: number
}

export interface FootMeasurement {
  /** Длина стопы, мм. */
  lengthMm: number
  /** Ширина стопы, мм. */
  widthMm: number
  /** Контур стопы (упрощённый hull) в пикселях исходного изображения. */
  contour: FootContourPoint[]
}

const A4_SHORT_SIDE_MM = 210
/** Соотношение сторон А4: 297/210 ≈ 1.414. */
const A4_RATIO = Math.SQRT2
/** Допуск на перспективу и неточность контура (~15–30°). */
const A4_RATIO_TOLERANCE = 0.35
const A4_MIN_AREA_FRAC = 0.15
const FOOT_MIN_AREA_FRAC = 0.02
/** Контур, близкий по площади к А4, считаем самим листом, а не стопой. */
const FOOT_MAX_VS_A4 = 0.75
/** Отступ от границы кадра: контуры у края — тени/фон. */
const BORDER_MARGIN_PX = 8

type CvMat = ReturnType<typeof getOpenCv>['Mat']['prototype']

/** Все созданные Mat/Scalar/MatVector складываем сюда и удаляем в finally. */
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

interface A4Sheet {
  /** Пикселей на миллиметр (по короткой стороне). */
  pxPerMm: number
  areaPx: number
}

/** Ищет лист А4 на кадре. Возвращает null, если лист не найден. */
function findA4Sheet(cv: ReturnType<typeof getOpenCv>, edges: CvMat, frameArea: number, t: MatTracker): A4Sheet | null {
  const contours = t.track(new cv.MatVector())
  const hierarchy = t.track(new cv.Mat())
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)

  for (let i = 0; i < contours.size(); i++) {
    const cnt = t.track(contours.get(i))
    const area = cv.contourArea(cnt)
    if (area < frameArea * A4_MIN_AREA_FRAC) continue

    const peri = cv.arcLength(cnt, true)
    const approx = t.track(new cv.Mat())
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true)
    if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue

    const pts = contourPoints(approx)
    const sides = [0, 1, 2, 3]
      .map((j) => dist(pts[j].x, pts[j].y, pts[(j + 1) % 4].x, pts[(j + 1) % 4].y))
      .sort((a, b) => a - b)

    const longSide = sides[3]
    const shortSide = sides[0]
    if (shortSide <= 0) continue
    const ratio = longSide / shortSide
    if (Math.abs(ratio - A4_RATIO) > A4_RATIO_TOLERANCE) continue

    // Две короткие стороны (в перспективе могут отличаться) — усредняем.
    const avgShortSide = (sides[0] + sides[1]) / 2
    return { pxPerMm: avgShortSide / A4_SHORT_SIDE_MM, areaPx: area }
  }
  return null
}

/** Ищет контур стопы на бинаризованном изображении. */
function findFootContour(
  cv: ReturnType<typeof getOpenCv>,
  binary: CvMat,
  srcW: number,
  srcH: number,
  frameArea: number,
  a4AreaPx: number,
  t: MatTracker
): CvMat | null {
  const contours = t.track(new cv.MatVector())
  const hierarchy = t.track(new cv.Mat())
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

  let best: CvMat | null = null
  let bestArea = 0
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i)
    const area = cv.contourArea(cnt)
    if (area < frameArea * FOOT_MIN_AREA_FRAC) continue
    if (area > a4AreaPx * FOOT_MAX_VS_A4) continue

    const box = cv.boundingRect(cnt)
    if (
      box.x <= BORDER_MARGIN_PX ||
      box.y <= BORDER_MARGIN_PX ||
      box.x + box.width >= srcW - BORDER_MARGIN_PX ||
      box.y + box.height >= srcH - BORDER_MARGIN_PX
    ) {
      cnt.delete()
      continue
    }

    if (area > bestArea) {
      if (best) best.delete()
      best = cnt
      bestArea = area
    } else {
      cnt.delete()
    }
  }
  return best
}

/**
 * Измеряет стопу по фото. Требуется лист А4 в кадре (калибровка масштаба).
 * @returns замер или null, если А4 не найден.
 */
export function measureFoot(imageData: ImageData): FootMeasurement | null {
  const cv = getOpenCv()
  const t = new MatTracker()
  try {
    const src = t.track(cv.matFromImageData(imageData))
    const frameArea = src.rows * src.cols

    const gray = t.track(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blurred = t.track(new cv.Mat())
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

    const edges = t.track(new cv.Mat())
    cv.Canny(blurred, edges, 50, 150)

    const a4 = findA4Sheet(cv, edges, frameArea, t)
    if (!a4) return null

    // --- Сегментация стопы ---
    const kernel = t.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)))
    const thresh = t.track(new cv.Mat())
    const morph = t.track(new cv.Mat())
    let foot: CvMat | null = null

    // Стопа на тёмном фоне — светлее подложки (THRESH_BINARY).
    // Если не нашлось — пробуем инверсию.
    for (const inv of [false, true]) {
      const flag = (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU
      cv.threshold(blurred, thresh, 0, 255, flag)
      cv.morphologyEx(thresh, morph, cv.MORPH_OPEN, kernel)
      cv.morphologyEx(morph, morph, cv.MORPH_CLOSE, kernel)
      foot = findFootContour(cv, morph, src.cols, src.rows, frameArea, a4.areaPx, t)
      if (foot) break
    }
    if (!foot) return null

    // --- Измерения ---
    // Длина: максимальное попарное расстояние по convex hull.
    const hull = t.track(new cv.Mat())
    cv.convexHull(foot, hull, false, true)
    const hullPts = contourPoints(hull)

    let lengthPx = 0
    for (let i = 0; i < hullPts.length; i++) {
      for (let j = i + 1; j < hullPts.length; j++) {
        const d = dist(hullPts[i].x, hullPts[i].y, hullPts[j].x, hullPts[j].y)
        if (d > lengthPx) lengthPx = d
      }
    }

    // Ширина: малая сторона bounding box минимальной площади.
    const rect = cv.minAreaRect(foot)
    const widthPx = Math.min(rect.size.width, rect.size.height)

    let lengthMm = lengthPx / a4.pxPerMm
    let widthMm = widthPx / a4.pxPerMm
    if (widthMm > lengthMm) [lengthMm, widthMm] = [widthMm, lengthMm]

    return {
      lengthMm: Math.round(lengthMm * 10) / 10,
      widthMm: Math.round(widthMm * 10) / 10,
      // Сохраняем упрощённый контур (не более ~120 точек).
      contour: hullPts.filter((_, i) => i % Math.max(1, Math.floor(hullPts.length / 120)) === 0)
    }
  } finally {
    t.dispose()
  }
}
