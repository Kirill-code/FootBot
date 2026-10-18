// Бинарная маска стопы из RGBA-кадра без NN и без OpenCV — для live-цикла
// видоискателя (каждые ~400 мс на кропе ≤560px, главный поток, чистый JS).
//
// Сценарий съёмки: стопа стоит на листе А4. Бумага — светлая и слабо
// насыщенная (высокий V, низкий S в HSV); кожа и носок заметно темнее
// и/или насыщеннее. Поэтому маска стопы = «не бумага»:
//   bin = 1, если НЕ (S < S_PAPER и V > V_PAPER)
// Тень от ноги на листе (тот же S, ниже V) формально попадает в маску —
// для live-подсказки это допустимо: финальный замер делает measureFoot
// (OpenCV) по полному кадру, здесь нужен лишь стабильный силуэт-ориентир.
//
// Полоса у краёв кропа обнуляется: за пределами листа виден пол, он тоже
// «не бумага» и иначе даёт крупную компоненту по периметру.

/** Пороги paper-классификации (совпадают по смыслу с filterPaperComponents). */
const PAPER_MAX_S = 70
const PAPER_MIN_V = 150

/** Доля края кропа, обнуляемая с каждой стороны (пол вокруг листа). */
const BORDER_FRAC = 0.04

/**
 * Маска «не бумага» по кадру.
 * @param rgba пиксели кадра (RGBA), длина w*h*4
 * @returns бинарная маска w*h (1 — кандидат стопы, 0 — бумага/фон/края)
 */
export function footBinFromFrame(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  const bx = Math.round(w * BORDER_FRAC)
  const by = Math.round(h * BORDER_FRAC)
  for (let y = 0; y < h; y++) {
    const inY = y >= by && y < h - by
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (!inY || x < bx || x >= w - bx) continue
      const o = (row + x) * 4
      const r = rgba[o]
      const g = rgba[o + 1]
      const b = rgba[o + 2]
      const max = r > g ? (r > b ? r : b) : g > b ? g : b
      const min = r < g ? (r < b ? r : b) : g < b ? g : b
      const s = max === 0 ? 0 : ((max - min) / max) * 255
      const v = max
      if (!(s < PAPER_MAX_S && v > PAPER_MIN_V)) bin[row + x] = 1
    }
  }
  return bin
}
