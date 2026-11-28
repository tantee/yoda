import { describe, expect, it } from 'vitest'
import { cellsInStroke, pixelate, pixelateCells, redactRect, type Img } from '../src/editor/pixels'

function gradient(w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 7 % 256, y * 5 % 256, (x + y) % 256, 255], (y * w + x) * 4)
  return { data, width: w, height: h }
}
const px = (img: Img, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

describe('pixelate', () => {
  it('makes every block inside the rect uniform and leaves pixels outside unchanged', () => {
    const img = gradient(64, 48)
    const before = gradient(64, 48)
    pixelate(img, { x: 8, y: 8, w: 32, h: 16 }, 8)
    for (let by = 8; by < 24; by += 8)
      for (let bx = 8; bx < 40; bx += 8) {
        const first = px(img, bx, by)
        for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) expect(px(img, x, y)).toEqual(first)
      }
    expect(px(img, 7, 7)).toEqual(px(before, 7, 7))
    expect(px(img, 40, 10)).toEqual(px(before, 40, 10))
    expect(px(img, 20, 24)).toEqual(px(before, 20, 24))
    // The block holds the mean colour.
    let r = 0
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) r += px(before, x, y)[0]!
    expect(px(img, 8, 8)[0]).toBe(Math.round(r / 64))
  })

  it('block edges at the image border are clamped', () => {
    const img = gradient(20, 20)
    pixelate(img, { x: 10, y: 10, w: 50, h: 50 }, 8)
    // The grid starts at the rect (10, 18): the last block (18..19) is partial, uniform, and stops at the edge.
    expect(px(img, 19, 19)).toEqual(px(img, 18, 18))
    expect(px(img, 17, 17)).toEqual(px(img, 10, 10))
    expect(img.data.length).toBe(20 * 20 * 4)
    pixelate(img, { x: -10, y: -10, w: 5, h: 5 }, 8)
  })
})

describe('cellsInStroke', () => {
  it('covers a diagonal stroke and nothing farther than width/2 + block', () => {
    const block = 8
    const width = 16
    const cells = cellsInStroke([0, 0, 63, 63], width, block, 64, 64)
    const cols = 64 / block
    expect(cells).toContain(0)
    expect(cells).toContain(cols * 7 + 7)
    for (const c of cells) {
      const cx = (c % cols) * block + block / 2
      const cy = Math.floor(c / cols) * block + block / 2
      const d = Math.abs(cx - cy) / Math.SQRT2
      expect(d).toBeLessThanOrEqual(width / 2 + block)
    }
    expect(cells).not.toContain(7)
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('pixelateCells makes each cell uniform', () => {
    const img = gradient(32, 32)
    pixelateCells(img, [0, 5], 8)
    expect(px(img, 7, 7)).toEqual(px(img, 0, 0))
    expect(px(img, 15, 15)).toEqual(px(img, 8, 8))
  })
})

describe('redactRect', () => {
  it('fills exactly the rect', () => {
    const img = gradient(16, 16)
    const before = gradient(16, 16)
    redactRect(img, { x: 2, y: 3, w: 4, h: 5 })
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const inside = x >= 2 && x < 6 && y >= 3 && y < 8
        expect(px(img, x, y)).toEqual(inside ? [26, 36, 51, 255] : px(before, x, y))
      }
  })
})
