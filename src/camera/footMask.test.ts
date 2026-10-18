import { describe, expect, it } from 'vitest'
import { footBinFromFrame } from './footMask'

/** Собирает RGBA-кадр w×h из функции цвета пикселя. */
function frame(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const [r, g, b] = px(x, y)
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = 255
    }
  }
  return rgba
}

const PAPER: [number, number, number] = [240, 238, 232] // белый лист
const SKIN: [number, number, number] = [198, 152, 120] // кожа — насыщеннее бумаги

describe('footBinFromFrame', () => {
  it('чистый лист А4 → пустая маска', () => {
    const rgba = frame(50, 40, () => PAPER)
    const bin = footBinFromFrame(rgba, 50, 40)
    expect(bin.reduce((a, v) => a + v, 0)).toBe(0)
  })

  it('стопа на листе → блоб внутри, бумага снаружи — нули', () => {
    // Стопа — прямоугольник кожи 10×20 в центре листа 60×50.
    const rgba = frame(60, 50, (x, y) => (x >= 25 && x < 35 && y >= 15 && y < 35 ? SKIN : PAPER))
    const bin = footBinFromFrame(rgba, 60, 50)
    // Центр стопы — в маске.
    expect(bin[25 * 60 + 30]).toBe(1)
    // Бумага в центре правой половины — вне маски.
    expect(bin[25 * 60 + 50]).toBe(0)
    // Площадь маски ~ площадь стопы (10×20 = 200).
    const area = bin.reduce((a, v) => a + v, 0)
    expect(area).toBe(200)
  })

  it('тёмный пол по краям кадра обнуляется бордюром', () => {
    // Лист в центре, тёмный пол — узким кольцом по периметру (в зоне бордюра).
    const rgba = frame(50, 50, (x, y) => (x >= 2 && x < 48 && y >= 2 && y < 48 ? PAPER : [60, 50, 45]))
    const bin = footBinFromFrame(rgba, 50, 50)
    // Угол кадра (пол) — не в маске.
    expect(bin[0]).toBe(0)
    expect(bin[49]).toBe(0)
    expect(bin.reduce((a, v) => a + v, 0)).toBe(0)
  })

  it('тень на листе (низкий V, низкий S) попадает в маску — осознанный компромисс live-подсказки', () => {
    const rgba = frame(30, 30, (_x, y) => (y >= 10 && y < 20 ? [120, 118, 115] : PAPER))
    const bin = footBinFromFrame(rgba, 30, 30)
    expect(bin[15 * 30 + 15]).toBe(1)
  })
})
