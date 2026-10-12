// Синтетические top-контуры: стопа строится по рядным профилям ширины.
// Большой палец = плавная прибавка ширины на внутренней половине в toe-third
// + смещение мыска к внутренней стороне.

import { describe, expect, it } from 'vitest'
import { detectLaterality } from './footLaterality'
import type { FootContourPoint } from './measureFoot'

function makeFoot(
  inner: 'left' | 'right' | null,
  opts: { bumpAmp?: number; tipShift?: number } = {}
): FootContourPoint[] {
  const { bumpAmp = 18, tipShift = 8 } = opts
  const L = 300
  const axis = 100
  const width = (y: number) =>
    8 + 38 * Math.exp(-(((y - 170) / 95) ** 2)) + 12 * Math.exp(-(((y - 295) / 35) ** 2))
  const bump = (y: number) => (inner && y < 120 ? bumpAmp * Math.exp(-(((y - 35) / 28) ** 2)) : 0)
  const shift = (y: number) =>
    inner && y < 25 ? (inner === 'left' ? -1 : 1) * tipShift * (1 - y / 25) : 0

  const right: FootContourPoint[] = []
  const left: FootContourPoint[] = []
  for (let y = 0; y <= L; y += 2) {
    const w = width(y)
    const s = shift(y)
    const b = bump(y)
    const wl = inner === 'left' ? w + b : w
    const wr = inner === 'right' ? w + b : w
    right.push({ x: axis + s + wr, y })
    left.push({ x: axis + s - wl, y })
  }
  return [...right, ...left.reverse()]
}

describe('detectLaterality', () => {
  it('большой палец слева + пальцы вверх → правая стопа', () => {
    const r = detectLaterality(makeFoot('left'), true)
    expect(r).not.toBeNull()
    expect(r!.side).toBe('right')
    expect(r!.innerSide).toBe('left')
    expect(r!.confidence).toBeGreaterThan(0.5)
  })

  it('большой палец справа + пальцы вверх → левая стопа', () => {
    const r = detectLaterality(makeFoot('right'), true)
    expect(r).not.toBeNull()
    expect(r!.side).toBe('left')
    expect(r!.innerSide).toBe('right')
  })

  it('симметричный контур → null', () => {
    expect(detectLaterality(makeFoot(null), true)).toBeNull()
  })

  it('пальцы вниз зеркалят результат', () => {
    const contour = makeFoot('right')
    expect(detectLaterality(contour, true)!.side).toBe('left')
    expect(detectLaterality(contour, false)!.side).toBe('right')
  })

  it('слабая асимметрия → null', () => {
    expect(detectLaterality(makeFoot('left', { bumpAmp: 2, tipShift: 1 }), true)).toBeNull()
  })

  it('вырожденный контур → null', () => {
    expect(detectLaterality([{ x: 0, y: 0 }, { x: 5, y: 2 }], true)).toBeNull()
  })
})
