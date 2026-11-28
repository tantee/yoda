import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickMimeType, recordClip } from '../src/offscreen/recorder'

class FakeRecorder {
  static last: FakeRecorder | null = null
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(
    public stream: unknown,
    public opts: { mimeType: string; videoBitsPerSecond: number },
  ) {
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' }) })
    this.onstop?.()
  }
}

const track = () => ({ stop: vi.fn() })
const stream = () => {
  const tracks = [track()]
  return { getTracks: () => tracks, tracks }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('pickMimeType', () => {
  it('prefers vp9, falls back to vp8, else plain webm', () => {
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp9')
    expect(pickMimeType((t) => !t.includes('vp9'))).toBe('video/webm;codecs=vp8')
    expect(pickMimeType(() => false)).toBe('video/webm')
  })
})

describe('recordClip', () => {
  it('the offscreen recorder stops itself at maxSeconds without the service worker', async () => {
    const s = stream()
    const done = vi.fn()
    recordClip(s as unknown as MediaStream, { maxSeconds: 30, Recorder: FakeRecorder as never, isSupported: () => true, fix: async (b) => b, onDone: done })
    expect(FakeRecorder.last!.state).toBe('recording')
    expect(FakeRecorder.last!.opts).toMatchObject({ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 1_000_000 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalledOnce()
    expect(done.mock.calls[0]![0]).toMatchObject({ reason: 'max' })
    expect(done.mock.calls[0]![0].blob.size).toBeGreaterThan(0)
    // The tab capture ends with the clip.
    expect(s.tracks[0]!.stop).toHaveBeenCalled()
  })

  it('stop() ends early, with the duration fixed in the file', async () => {
    const fix = vi.fn(async (b: Blob, _ms: number) => b)
    const done = vi.fn()
    const r = recordClip(stream() as unknown as MediaStream, { maxSeconds: 30, Recorder: FakeRecorder as never, isSupported: () => true, fix, onDone: done })
    await vi.advanceTimersByTimeAsync(5_000)
    r.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(done.mock.calls[0]![0]).toMatchObject({ reason: 'stopped' })
    expect(fix.mock.calls[0]![1]).toBe(5_000)
    // A late hard stop does nothing more.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(done).toHaveBeenCalledOnce()
  })
})
