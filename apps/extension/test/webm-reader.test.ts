import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readWebm } from '../src/video/webm-reader'

// 1 s of coloured rectangles at 160x120, recorded once by Chromium's MediaRecorder (vp8); synthetic frames only.
const clip = new Uint8Array(readFileSync(new URL('./fixtures/clip.webm', import.meta.url)))

/** The same file with the Segment and every Cluster marked unknown-size, as a live MediaRecorder writes them. */
function unknownSizes(buf: Uint8Array): Uint8Array {
  const b = buf.slice()
  const ids = [
    [0x18, 0x53, 0x80, 0x67],
    [0x1f, 0x43, 0xb6, 0x75],
  ]
  let patched = 0
  for (let i = 0; i + 12 <= b.length; i++)
    for (const id of ids)
      if (id.every((v, k) => b[i + k] === v) && b[i + 4] === 0x01) {
        b.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], i + 4)
        patched++
      }
  expect(patched).toBeGreaterThanOrEqual(2)
  return b
}

const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]
const size8 = (n: number) => [0x01, ...[48, 40, 32, 24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) & 0xff)]

/**
 * A second copy of the fixture's cluster at 2 s, with the first cluster's size running to the end of the file:
 * fix-webm-duration (applied to every clip) writes the first cluster's size like that.
 */
function firstClusterOversized(buf: Uint8Array): Uint8Array {
  // The element itself (the SeekHead also names the Cluster ID), with the 8-byte size MediaRecorder writes.
  const c = buf.findIndex((_, i) => CLUSTER.every((v, k) => buf[i + k] === v) && buf[i + 4] === 0x01)
  const size = [...buf.subarray(c + 5, c + 12)].reduce((n, v) => n * 256 + v, 0)
  const end = c + 12 + size
  expect([...buf.subarray(c + 12, c + 15)]).toEqual([0xe7, 0x81, 0x00])
  const body = [0xe7, 0x82, 0x07, 0xd0, ...buf.subarray(c + 15, end)]
  const out = new Uint8Array([...buf.subarray(0, end), ...CLUSTER, ...size8(body.length), ...body, ...buf.subarray(end)])
  out.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], out.findIndex((_, i) => [0x18, 0x53, 0x80, 0x67].every((v, k) => out[i + k] === v)) + 4)
  out.set(size8(out.length - (c + 12)), c + 4)
  return out
}

describe('readWebm', () => {
  it('reads codec, size and SimpleBlocks from a small fixture WebM', () => {
    const w = readWebm(clip)
    expect(w.codec).toBe('V_VP8')
    expect(w).toMatchObject({ width: 160, height: 120 })
    expect(w.frames.length).toBeGreaterThan(15)
    expect(w.frames.length).toBeLessThan(45)
    expect(w.frames[0]!.key).toBe(true)
    expect(w.frames[0]!.timestampUs).toBe(0)
    // Timestamps in microseconds, increasing, within the 1 s recorded.
    for (let i = 1; i < w.frames.length; i++) expect(w.frames[i]!.timestampUs).toBeGreaterThan(w.frames[i - 1]!.timestampUs)
    expect(w.frames.at(-1)!.timestampUs).toBeLessThan(1_500_000)
    // A VP8 key frame has bit 0 of its first byte clear and the start code 9d 01 2a after its 3-byte tag.
    for (const f of w.frames) {
      expect(f.data.length).toBeGreaterThan(0)
      expect(f.key).toBe((f.data[0]! & 1) === 0)
      if (f.key) expect([...f.data.subarray(3, 6)]).toEqual([0x9d, 0x01, 0x2a])
    }
  })

  it('reads the same frames when the Segment and Clusters have unknown size', () => {
    const a = readWebm(clip)
    const b = readWebm(unknownSizes(clip).buffer as ArrayBuffer)
    expect(b.codec).toBe(a.codec)
    expect(b.frames.map((f) => [f.timestampUs, f.key, f.data.length])).toEqual(a.frames.map((f) => [f.timestampUs, f.key, f.data.length]))
  })

  it('reads every cluster when the first one claims the rest of the file (fix-webm-duration output)', () => {
    const a = readWebm(clip)
    const b = readWebm(firstClusterOversized(clip))
    expect(b.frames).toHaveLength(a.frames.length * 2)
    expect(b.frames[a.frames.length]!.timestampUs).toBe(2_000_000 + a.frames[0]!.timestampUs)
  })

  it('refuses a file that is not WebM', () => {
    expect(() => readWebm(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow()
  })
})
