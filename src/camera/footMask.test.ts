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
const SKIN: [number, number, number] = [198, 152, 120] // кожа
const WOOD: [number, number, number] = [170, 130, 90] // ламинат
const FLOOR_DARK: [number, number, number] = [60, 50, 45] // тёмный пол

const area = (bin: Uint8Array) => bin.reduce((a, v) => a + v, 0)

describe('footBinFromFrame', () => {
  it('чистый лист А4 → пустая маска', () => {
    const bin = footBinFromFrame(frame(50, 40, () => PAPER), 50, 40)
    expect(area(bin)).toBe(0)
  })

  it('однородный деревянный пол без листа → пустая маска (регрессия: контур на весь кадр)', () => {
    // Лёгкий градиент-текстура дерева: фон однороден, «стопы» нет.
    const bin = footBinFromFrame(
      frame(60, 50, (x, y) => [WOOD[0] - ((x + y) % 7), WOOD[1] - ((x + y) % 5), WOOD[2]]),
      60,
      50
    )
    expect(area(bin)).toBeLessThan(60 * 50 * 0.05)
  })

  it('стопа на листе → блоб внутри, бумага снаружи — нули', () => {
    // Стопа — прямоугольник кожи 10×20 в центре листа 60×50.
    const rgba = frame(60, 50, (x, y) => (x >= 25 && x < 35 && y >= 15 && y < 35 ? SKIN : PAPER))
    const bin = footBinFromFrame(rgba, 60, 50)
    expect(bin[25 * 60 + 30]).toBe(1) // центр стопы — в маске
    expect(bin[25 * 60 + 50]).toBe(0) // бумага справа — вне маски
    expect(area(bin)).toBe(200) // площадь маски ≈ площадь стопы (10×20)
  })

  it('стопа на деревянном полу выделяется от фона кольца', () => {
    const rgba = frame(60, 50, (x, y) => (x >= 25 && x < 35 && y >= 15 && y < 35 ? SKIN : WOOD))
    const bin = footBinFromFrame(rgba, 60, 50)
    expect(bin[25 * 60 + 30]).toBe(1)
    expect(area(bin)).toBeGreaterThan(150)
  })

  it('тёмный пол по краям + белый лист в центре → лист НЕ становится стопой', () => {
    // Кольцо оценки фона (8% = 4px) целиком в полу: bg=пол, лист контрастен,
    // но отсекается paper-фильтром.
    const rgba = frame(50, 50, (x, y) => (x >= 4 && x < 46 && y >= 4 && y < 46 ? PAPER : FLOOR_DARK))
    const bin = footBinFromFrame(rgba, 50, 50)
    expect(area(bin)).toBe(0)
  })

  it('тень на листе (низкий V) попадает в маску — осознанный компромисс live-подсказки', () => {
    const rgba = frame(30, 30, (_x, y) => (y >= 10 && y < 20 ? [120, 118, 115] : PAPER))
    const bin = footBinFromFrame(rgba, 30, 30)
    expect(bin[15 * 30 + 15]).toBe(1)
  })
})
