import { describe, expect, it } from 'vitest'
import { applyDestructive, cropRect } from '../src/editor/flatten'
import type { EditorDoc } from '../src/editor/doc'
import type { Img } from '../src/editor/pixels'

function gradient(w: number, h: number): Img {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 4 % 256, y * 3 % 256, 100, 255], (y * w + x) * 4)
  return { data, width: w, height: h }
}

describe('flatten (pixel stage)', () => {
  it('mosaic then arrow: the arrow is a vector op, so its pixels are drawn after and not pixelated', () => {
    const doc: EditorDoc = { width: 64, height: 64, ops: [
      { kind: 'mosaic', mode: 'rect', rect: { x: 0, y: 0, w: 64, h: 64 }, block: 8 },
      { kind: 'arrow', points: [0, 0, 60, 60], colour: '#B3261E', width: 4 },
    ] }
    const img = gradient(64, 64)
    const { vector } = applyDestructive(img, doc.ops)
    expect(vector.map((o) => o.kind)).toEqual(['arrow'])
  })

  it('the exported pixels inside a mosaic rect differ from the original (gradient source)', () => {
    const img = gradient(64, 64)
    const before = gradient(64, 64)
    applyDestructive(img, [{ kind: 'mosaic', mode: 'rect', rect: { x: 8, y: 8, w: 32, h: 32 }, block: 8 }])
    let differ = 0
    for (let i = 0; i < img.data.length; i++) if (img.data[i] !== before.data[i]) differ++
    expect(differ).toBeGreaterThan(0)
  })

  it('applies blur, redact and both mosaic modes in document order; crop applies last', () => {
    const img = gradient(64, 64)
    const r = applyDestructive(img, [
      { kind: 'redact', rect: { x: 0, y: 0, w: 8, h: 8 } },
      { kind: 'mosaic', mode: 'brush', points: [0, 32, 63, 32], width: 8, block: 8 },
      { kind: 'crop', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { kind: 'crop', rect: { x: 4, y: 4, w: 32, h: 20 } },
      { kind: 'blur', rect: { x: 40, y: 40, w: 10, h: 10 }, radius: 12 },
    ])
    expect(Array.from(img.data.slice(0, 4))).toEqual([26, 36, 51, 255])
    // The blur changed pixels inside its rect (a gradient), and nothing outside it.
    const before = gradient(64, 64)
    const at = (i: Img, x: number, y: number) => i.data[(y * 64 + x) * 4]
    expect(at(img, 45, 45)).not.toBe(at(before, 45, 45))
    expect(at(img, 60, 45)).toBe(at(before, 60, 45))
    expect(r.crop).toEqual({ x: 4, y: 4, w: 32, h: 20 })
    expect(r.vector).toEqual([])
    expect(cropRect([{ kind: 'crop', rect: { x: 0, y: 0, w: 10, h: 10 } }, { kind: 'crop', rect: { x: 4, y: 4, w: 32, h: 20 } }])).toEqual({ x: 4, y: 4, w: 32, h: 20 })
  })
})
