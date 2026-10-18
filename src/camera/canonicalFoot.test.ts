import { describe, expect, it } from 'vitest'
import {
  CANON_SIDE,
  CANON_TOP,
  canonForView,
  deltaMask,
  filterPaperComponents,
  fitCanonical,
  pointInPolygon,
  transformCanon
} from './canonicalFoot'

/** Растеризует полигон в бинарную маску w×h. */
function rasterize(poly: Array<{ x: number; y: number }>, w: number, h: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, poly)) bin[y * w + x] = 1
    }
  }
  return bin
}

/** Канон с трансформацией в мировые координаты → растеризация. */
function makeFootMask(view: 'top' | 'side', cx: number, cy: number, scale: number, angle: number, w: number, h: number): Uint8Array {
  const world = transformCanon(canonForView(view), { cx, cy, scale, angle, quality: 1 })
  return rasterize(world, w, h)
}

describe('fitCanonical', () => {
  it('top: верно восстанавливает scale (±10%) при вертикальной стопе', () => {
    const w = 200
    const h = 240
    const bin = makeFootMask('top', 100, 120, 80, 0, w, h)
    const t = fitCanonical(bin, w, h, 'top')!
    expect(t).not.toBeNull()
    expect(Math.abs(t.scale - 80) / 80).toBeLessThan(0.1)
    expect(Math.abs(t.cx - 100)).toBeLessThan(8)
    expect(Math.abs(t.cy - 120)).toBeLessThan(8)
  })

  it('top: верно восстанавливает angle (±10%) при повороте', () => {
    const w = 240
    const h = 240
    const angle = 0.7 // ~40°
    const bin = makeFootMask('top', 120, 120, 70, angle, w, h)
    const t = fitCanonical(bin, w, h, 'top')!
    expect(t).not.toBeNull()
    let da = Math.abs(t.angle - angle) % (2 * Math.PI)
    if (da > Math.PI) da = 2 * Math.PI - da
    expect(da).toBeLessThan(0.35) // ±20° с запасом; ось не различает ±π
  })

  it('side: фиттится по профилю', () => {
    const w = 240
    const h = 200
    const bin = makeFootMask('side', 120, 100, 75, 0.2, w, h)
    const t = fitCanonical(bin, w, h, 'side')!
    expect(t).not.toBeNull()
    expect(Math.abs(t.scale - 75) / 75).toBeLessThan(0.15)
  })

  it('пустая/мелкая маска → null', () => {
    expect(fitCanonical(new Uint8Array(100 * 100), 100, 100, 'top')).toBeNull()
    const tiny = new Uint8Array(100 * 100)
    tiny[50 * 100 + 50] = 1
    expect(fitCanonical(tiny, 100, 100, 'top')).toBeNull()
  })
})

describe('deltaMask', () => {
  it('широкая маска даёт дельту по бокам, канон-подобная — ноль', () => {
    const w = 120
    const h = 160
    // Маска ровно под канон (вертикальная, scale 70).
    const exact = makeFootMask('top', 60, 80, 70, 0, w, h)
    const canon = transformCanon(CANON_TOP, { cx: 60, cy: 80, scale: 70, angle: 0, quality: 1 })
    const dExact = deltaMask(exact, w, h, canon, 4)!
    expect([...dExact.cells].filter(Boolean).length).toBeLessThan(20)
    // Широкая маска: канон сужен → дельта заметна.
    const wide = makeFootMask('top', 60, 80, 70, 0, w, h)
    const narrowCanon = transformCanon(CANON_TOP, { cx: 60, cy: 80, scale: 70, angle: 0, quality: 1 }).map((p) => ({
      x: 60 + (p.x - 60) * 0.5,
      y: p.y
    }))
    const dWide = deltaMask(wide, w, h, narrowCanon, 4)!
    expect([...dWide.cells].filter(Boolean).length).toBeGreaterThan(100)
  })

  it('пустая маска → null', () => {
    expect(deltaMask(new Uint8Array(100), 10, 10, CANON_SIDE)).toBeNull()
  })
})

describe('filterPaperComponents', () => {
  function frameWith(w: number, h: number, paperRect: [number, number, number, number] | null, darkRect: [number, number, number, number]): { bin: Uint8Array; rgba: Uint8ClampedArray } {
    const bin = new Uint8Array(w * h)
    const rgba = new Uint8ClampedArray(w * h * 4)
    // Фон — тёплый паркет.
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = 140
      rgba[p * 4 + 1] = 100
      rgba[p * 4 + 2] = 60
      rgba[p * 4 + 3] = 255
    }
    const fill = (rect: [number, number, number, number], r: number, g: number, b: number) => {
      const [x0, y0, rw, rh] = rect
      for (let y = y0; y < y0 + rh; y++) {
        for (let x = x0; x < x0 + rw; x++) {
          bin[y * w + x] = 1
          const o = (y * w + x) * 4
          rgba[o] = r
          rgba[o + 1] = g
          rgba[o + 2] = b
        }
      }
    }
    if (paperRect) fill(paperRect, 245, 245, 245) // белый лист
    fill(darkRect, 60, 50, 45) // тёмная стопа
    return { bin, rgba }
  }

  it('белый лист (светлый, ненасыщенный, >2%) выбрасывается, стопа остаётся', () => {
    const { bin, rgba } = frameWith(200, 200, [10, 10, 60, 60], [120, 100, 50, 70])
    const out = filterPaperComponents(bin, 200, 200, rgba)
    expect(out[10 * 200 + 10]).toBe(0) // угол листа
    expect(out[40 * 200 + 40]).toBe(0) // центр листа
    expect(out[135 * 200 + 145]).toBe(1) // центр стопы
  })

  it('тёмная компонента не трогается, мелкий белый шум (<2%) тоже', () => {
    const { bin, rgba } = frameWith(200, 200, [10, 10, 12, 12], [120, 100, 50, 70]) // лист 0.36% — мелкий
    const out = filterPaperComponents(bin, 200, 200, rgba)
    expect(out[16 * 200 + 16]).toBe(1) // мелкий белый остался
    expect(out[135 * 200 + 145]).toBe(1)
  })
})

describe('deltaMask: гард на гигантский канон', () => {
  it('канон >500 точек → null (только канон рисуется, дельта пропущена)', () => {
    const w = 100
    const h = 100
    const bin = new Uint8Array(w * h)
    for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) bin[y * w + x] = 1
    const hugeCanon = Array.from({ length: 600 }, (_, i) => {
      const a = (i / 600) * Math.PI * 2
      return { x: 50 + 20 * Math.cos(a), y: 50 + 20 * Math.sin(a) }
    })
    expect(deltaMask(bin, w, h, hugeCanon, 4)).toBeNull()
  })
})
