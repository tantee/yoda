import { describe, expect, it } from 'vitest'
import { framePlacements, planStitch } from '../src/capture/stitch'

describe('planStitch', () => {
  it('one screen is one frame', () => {
    expect(planStitch({ scrollHeight: 800, viewportHeight: 800, dpr: 1 })).toEqual({ offsets: [0], height: 800, truncated: false })
    expect(planStitch({ scrollHeight: 600, viewportHeight: 800, dpr: 1 })).toEqual({ offsets: [0], height: 600, truncated: false })
  })
  it('2.5 screens: full frames, the last one aligned to the bottom', () => {
    expect(planStitch({ scrollHeight: 2000, viewportHeight: 800, dpr: 1 })).toEqual({ offsets: [0, 800, 1200], height: 2000, truncated: false })
  })
  it('40 screens: the 15000 px cap gives truncated: true', () => {
    const p = planStitch({ scrollHeight: 32000, viewportHeight: 800, dpr: 1 })
    expect(p.truncated).toBe(true)
    expect(p.height).toBe(15000)
    expect(p.offsets).toEqual(Array.from({ length: 18 }, (_, i) => i * 800).concat([14200]))
    expect(p.offsets.at(-1)! + 800).toBe(15000)
  })
  it('dpr 2 halves the CSS cap', () => {
    const p = planStitch({ scrollHeight: 32000, viewportHeight: 800, dpr: 2 })
    expect(p.height).toBe(7500)
    expect(p.offsets.at(-1)! + 800).toBe(7500)
    expect(p.truncated).toBe(true)
  })
})

describe('framePlacements', () => {
  it('the document: whole frames, one under the other', () => {
    const p = framePlacements([0, 800, 1200], { left: 0, top: 0, width: 1280, height: 800 }, 2)
    expect(p.canvas).toEqual({ width: 2560, height: 4000 })
    expect(p.draws.map((d) => d.dy)).toEqual([0, 1600, 2400])
    expect(p.draws[0]).toMatchObject({ sx: 0, sy: 0, sw: 2560, sh: 1600 })
  })

  it('an inner scroller under a 64 px header: only its box is taken, so the header is not repeated', () => {
    const view = { left: 240, top: 64, width: 1040, height: 736 }
    const p = framePlacements([0, 736, 1000], view, 1)
    expect(p.canvas).toEqual({ width: 1040, height: 1736 })
    for (const d of p.draws) expect(d).toMatchObject({ sx: 240, sy: 64, sw: 1040, sh: 736, dx: 0 })
    expect(p.draws.map((d) => d.dy)).toEqual([0, 736, 1000])
  })
})
