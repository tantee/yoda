import { describe, expect, it } from 'vitest'
import { planStitch } from '../src/capture/stitch'

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
