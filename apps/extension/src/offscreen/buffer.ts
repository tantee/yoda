import fixWebmDuration from 'fix-webm-duration'
import type { Clip } from '../drafts/clips'
import { CLIP_BITS_PER_SECOND, pickMimeType } from './recorder'
import { BUFFER_MAX_MS, BUFFER_SEGMENT_MS, type JobHandler, type OffscreenMsg } from './router'

/**
 * The replay buffer (D1), in the offscreen document. The last 30–60 s of the tab live here, in memory only, as two
 * segments: the previous complete one and the current one. Nothing reaches IndexedDB or storage until the tester
 * saves. The 15-minute disarm is a timer here, so it holds while the service worker is stopped (decision 16).
 */
export { BUFFER_MAX_MS, BUFFER_SEGMENT_MS }

type Seg = { chunks: Blob[]; startedAt: number; endedAt?: number }
export type Segment = { blob: Blob; durationMs: number }

export class SegmentRing {
  private prev: Seg | null = null
  private cur: Seg

  constructor(readonly segmentMs = BUFFER_SEGMENT_MS) {
    this.cur = { chunks: [], startedAt: Date.now() }
  }

  push(chunk: Blob): void {
    if (chunk.size) this.cur.chunks.push(chunk)
  }

  /** The current segment becomes the previous one (the one before is dropped), and a new one starts. */
  rotate(): void {
    const now = Date.now()
    this.prev = { ...this.cur, endedAt: now }
    this.cur = { chunks: [], startedAt: now }
  }

  /** The previous and the current segment (each left out when empty), with their lengths. */
  segments(type = 'video/webm'): Segment[] {
    const now = Date.now()
    return [this.prev, this.cur]
      .filter((s): s is Seg => !!s && s.chunks.length > 0)
      .map((s) => ({ blob: new Blob(s.chunks, { type }), durationMs: (s.endedAt ?? now) - s.startedAt }))
  }

  snapshot(): Blob[] {
    return this.segments().map((s) => s.blob)
  }

  clear(): void {
    this.prev = null
    this.cur = { chunks: [], startedAt: Date.now() }
  }
}

type RecorderCtor = new (stream: MediaStream, opts: { mimeType: string; videoBitsPerSecond: number }) => {
  state: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(timeslice?: number): void
  stop(): void
}

export type SelfDisarm = 'timeout' | 'tab_closed'
type RecorderOpts = { Recorder?: RecorderCtor; isSupported?: (type: string) => boolean; fix?: (blob: Blob, ms: number) => Promise<Blob> }

/**
 * Records `stream` into a SegmentRing, with a fresh MediaRecorder for each segment (each one a standalone, playable
 * WebM). It disarms itself after `maxMs` or when the capture ends (`onDisarmed`). `save` stops it and returns the
 * segments with their duration written in; `stop` discards everything.
 */
export function runBuffer(
  stream: MediaStream,
  o: RecorderOpts & { segmentMs?: number; maxMs?: number; onDisarmed: (reason: SelfDisarm) => void },
): { save: () => Promise<Segment[]>; stop: () => void } {
  const Recorder = o.Recorder ?? (MediaRecorder as unknown as RecorderCtor)
  const isSupported = o.isSupported ?? ((t: string) => MediaRecorder.isTypeSupported(t))
  const fix = o.fix ?? ((b: Blob, ms: number) => fixWebmDuration(b, ms, { logger: false }))
  const mimeType = pickMimeType(isSupported)
  const type = mimeType.split(';')[0]!
  const segmentMs = o.segmentMs ?? BUFFER_SEGMENT_MS
  const ring = new SegmentRing(segmentMs)
  let rec: InstanceType<RecorderCtor> | null = null
  let segTimer: ReturnType<typeof setTimeout> | null = null
  let over = false

  const start = () => {
    const r = new Recorder(stream, { mimeType, videoBitsPerSecond: CLIP_BITS_PER_SECOND })
    rec = r
    r.ondataavailable = (e) => {
      if (rec === r && !over) ring.push(e.data)
    }
    r.start(1000)
    segTimer = setTimeout(rotate, segmentMs)
  }
  // The old recorder's last chunk arrives before its onstop: only then the ring turns and the next one starts.
  const rotate = () => {
    const r = rec
    if (!r || over) return
    r.onstop = () => {
      if (over) return
      ring.rotate()
      start()
    }
    r.stop()
  }
  const release = () => {
    over = true
    if (segTimer) clearTimeout(segTimer)
    clearTimeout(max)
    for (const t of stream.getTracks()) t.stop()
  }
  const discard = () => {
    if (over) return
    release()
    const r = rec
    rec = null
    if (r) {
      r.ondataavailable = null
      r.onstop = null
      if (r.state !== 'inactive') r.stop()
    }
    ring.clear()
  }
  const selfDisarm = (reason: SelfDisarm) => {
    if (over) return
    discard()
    o.onDisarmed(reason)
  }
  const max = setTimeout(() => selfDisarm('timeout'), o.maxMs ?? BUFFER_MAX_MS)
  // The tab closing ends the capture track (navigation does not: the worker watches that).
  for (const t of stream.getTracks()) (t as MediaStreamTrack).onended = () => selfDisarm('tab_closed')

  const save = async (): Promise<Segment[]> => {
    if (over) return []
    if (segTimer) clearTimeout(segTimer)
    clearTimeout(max)
    const r = rec
    // Stop the current recorder and wait for its last chunk.
    if (r && r.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        r.onstop = () => resolve()
        r.stop()
      })
    }
    const segs = ring.segments(type)
    rec = null
    release()
    ring.clear()
    return Promise.all(segs.map(async (s) => ({ durationMs: s.durationMs, blob: await fix(s.blob, s.durationMs).catch(() => s.blob) })))
  }

  start()
  return { save, stop: discard }
}

export type BufferJobDeps = RecorderOpts & {
  stream: (m: Extract<OffscreenMsg, { job: 'buffer'; type: 'start' }>) => Promise<MediaStream>
  send: (m: { type: 'buffer.disarmed'; reason: SelfDisarm }) => unknown
  putClip: (c: Clip) => Promise<void>
}

/** The document's `buffer` job: start, stop (discard) and save (the segments handed to the worker as clips). */
export function bufferJob(deps: BufferJobDeps): JobHandler {
  let running: { tabId: number; buf: ReturnType<typeof runBuffer> } | null = null
  return async (m) => {
    if (m.job !== 'buffer') return { ok: false }
    if (m.type === 'stop') {
      running?.buf.stop()
      running = null
      return { ok: true }
    }
    if (m.type === 'save') {
      const r = running
      running = null
      if (!r) return { ok: false, error: 'not_armed' }
      const segs = await r.buf.save()
      const clips: string[] = []
      // Handed over only now, when the tester saves; the worker deletes them once the draft holds them.
      for (const s of segs) {
        const id = crypto.randomUUID()
        await deps.putClip({ id, tabId: r.tabId, blob: s.blob, durationMs: s.durationMs, createdAt: Date.now() })
        clips.push(id)
      }
      return { ok: true, clips }
    }
    if (m.type !== 'start') return { ok: false, error: 'unknown' }
    if (running) return { ok: false, error: 'busy' }
    const stream = await deps.stream(m)
    try {
      const buf = runBuffer(stream, {
        Recorder: deps.Recorder,
        isSupported: deps.isSupported,
        fix: deps.fix,
        // Shorter segments only for the e2e run (the worker sends none otherwise); never longer than 30 s.
        segmentMs: m.segmentMs ? Math.min(Math.max(m.segmentMs, 1000), BUFFER_SEGMENT_MS) : BUFFER_SEGMENT_MS,
        onDisarmed: (reason) => {
          running = null
          void Promise.resolve(deps.send({ type: 'buffer.disarmed', reason })).catch(() => {})
        },
      })
      running = { tabId: m.tabId, buf }
    } catch (e) {
      for (const t of stream.getTracks()) t.stop()
      throw e
    }
    return { ok: true }
  }
}
