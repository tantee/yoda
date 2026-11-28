import { describe, expect, it, vi } from 'vitest'
import { acceptReencode, activeRegions, applyVideoMosaic, type Reencode, type VideoRegion } from '../src/video/regions'

const region = (id: string, fromMs: number, toMs: number): VideoRegion => ({ id, rect: { x: 0, y: 0, w: 10, h: 10 }, fromMs, toMs, block: 12 })
const src = new Blob([new Uint8Array(8)], { type: 'video/webm' })
const opts = () => ({ mimeType: 'video/webm;codecs=vp8', bitsPerSecond: 1_000_000, onProgress: () => {}, signal: new AbortController().signal, preview: {} as HTMLCanvasElement })
const out = (framesIn: number, framesOut: number) => ({ blob: new Blob([new Uint8Array(framesOut)], { type: 'video/webm' }), framesIn, framesOut })

describe('activeRegions', () => {
  it('counts fromMs in and toMs out', () => {
    const rs = [region('a', 1000, 3000), region('b', 2000, 2500)]
    expect(activeRegions(rs, 999).map((r) => r.id)).toEqual([])
    expect(activeRegions(rs, 1000).map((r) => r.id)).toEqual(['a'])
    expect(activeRegions(rs, 2000).map((r) => r.id)).toEqual(['a', 'b'])
    expect(activeRegions(rs, 2500).map((r) => r.id)).toEqual(['a'])
    expect(activeRegions(rs, 2999).map((r) => r.id)).toEqual(['a'])
    expect(activeRegions(rs, 3000).map((r) => r.id)).toEqual([])
  })
})

describe('acceptReencode', () => {
  it('is too lossy under 90% of the source frames', () => {
    expect(acceptReencode({ framesIn: 100, framesOut: 100 })).toBe('ok')
    expect(acceptReencode({ framesIn: 100, framesOut: 90 })).toBe('ok')
    expect(acceptReencode({ framesIn: 100, framesOut: 89 })).toBe('too_lossy')
    expect(acceptReencode({ framesIn: 0, framesOut: 0 })).toBe('too_lossy')
  })
})

describe('applyVideoMosaic', () => {
  it('keeps the recorder result when it is good enough', async () => {
    const webcodecs = vi.fn<Reencode>()
    const r = await applyVideoMosaic(src, [region('a', 0, 1000)], opts(), { recorder: async () => out(30, 29), webcodecs })
    expect(r).toMatchObject({ ok: true, path: 'recorder', framesIn: 30, framesOut: 29 })
    expect(webcodecs).not.toHaveBeenCalled()
  })

  it('tries WebCodecs after a lossy recorder result, and reports failure when both fail', async () => {
    const good = await applyVideoMosaic(src, [region('a', 0, 1000)], opts(), { recorder: async () => out(30, 20), webcodecs: async () => out(30, 30) })
    expect(good).toMatchObject({ ok: true, path: 'webcodecs', framesIn: 30, framesOut: 30 })
    if (good.ok) expect(good.blob.size).toBe(30)

    const thrown = await applyVideoMosaic(src, [region('a', 0, 1000)], opts(), {
      recorder: async () => {
        throw new Error('unsupported')
      },
      webcodecs: async () => out(30, 30),
    })
    expect(thrown).toMatchObject({ ok: true, path: 'webcodecs' })

    const bad = await applyVideoMosaic(src, [region('a', 0, 1000)], opts(), {
      recorder: async () => out(30, 10),
      webcodecs: async () => {
        throw new Error('no decoder')
      },
    })
    expect(bad).toEqual({ ok: false })
    const lossy = await applyVideoMosaic(src, [region('a', 0, 1000)], opts(), { recorder: async () => out(30, 10), webcodecs: async () => out(30, 20) })
    expect(lossy).toEqual({ ok: false })
  })

  it('stops at Cancel instead of trying the next path', async () => {
    const ac = new AbortController()
    const webcodecs = vi.fn<Reencode>()
    const r = await applyVideoMosaic(src, [region('a', 0, 1000)], { ...opts(), signal: ac.signal }, {
      recorder: async () => {
        ac.abort()
        throw new DOMException('cancelled', 'AbortError')
      },
      webcodecs,
    })
    expect(r).toEqual({ ok: false, cancelled: true })
    expect(webcodecs).not.toHaveBeenCalled()
  })
})
