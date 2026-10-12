import { describe, expect, it } from 'vitest'
import { largestComponent, maskToContour, personBinFromCategories, simplifyPolygon } from './liveContour'

function rectMask(w: number, h: number, x0: number, y0: number, rw: number, rh: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) m[y * w + x] = 1
  return m
}

describe('liveContour', () => {
  it('largestComponent выбирает крупнейший блоб и отсекает мелочь', () => {
    const w = 40
    const h = 30
    const m = rectMask(w, h, 2, 2, 20, 15)
    m[25 * w + 35] = 1 // одиночный пиксель
    const comp = largestComponent(m, w, h)!
    expect(comp.area).toBe(300)
    expect(comp.x).toBe(2)
    expect(comp.y).toBe(2)
    expect(comp.width).toBe(20)
    expect(comp.height).toBe(15)
  })

  it('largestComponent: null на пустой маске и мелком шуме', () => {
    expect(largestComponent(new Uint8Array(100), 10, 10)).toBeNull()
    const noise = new Uint8Array(100)
    noise[5] = 1
    expect(largestComponent(noise, 10, 10)).toBeNull()
  })

  it('maskToContour: прямоугольник → контур с bbox блоба', () => {
    const w = 60
    const h = 50
    const m = rectMask(w, h, 10, 8, 25, 20)
    const c = maskToContour(m, w, h)!
    expect(c.length).toBeGreaterThanOrEqual(4)
    const xs = c.map((p) => p.x)
    const ys = c.map((p) => p.y)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(9)
    expect(Math.max(...xs)).toBeLessThanOrEqual(36)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(7)
    expect(Math.max(...ys)).toBeLessThanOrEqual(29)
  })

  it('simplifyPolygon схлопывает прямую линию', () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 5 }))
    const s = simplifyPolygon(line, 1.5)
    expect(s.length).toBeLessThanOrEqual(3)
  })

  it('personBinFromCategories берёт только 2|3|4', () => {
    const cats = new Uint8Array([0, 1, 2, 3, 4, 5, 2])
    expect([...personBinFromCategories(cats)]).toEqual([0, 0, 1, 1, 1, 0, 1])
  })
})
