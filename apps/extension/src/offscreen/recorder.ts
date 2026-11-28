import fixWebmDuration from 'fix-webm-duration'

/** About 1 Mbit/s, video only (decision 16): a 30 s clip is about 4 MB. */
export const CLIP_BITS_PER_SECOND = 1_000_000

/** vp9 where the browser records it, else vp8, else whatever webm it offers. */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8']) if (isSupported(t)) return t
  return 'video/webm'
}

type RecorderCtor = new (stream: MediaStream, opts: { mimeType: string; videoBitsPerSecond: number }) => {
  state: string
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(timeslice?: number): void
  stop(): void
}

export type ClipResult = { blob: Blob; durationMs: number; reason: 'max' | 'stopped' | 'ended' }

/**
 * Records a stream to WebM. The hard stop at `maxSeconds` is a timer here, in the offscreen document (decision 16):
 * it holds even if the service worker sleeps. The tracks stop with the clip, and the duration is written into the
 * file (MediaRecorder leaves it unknown, so players cannot seek).
 */
export function recordClip(
  stream: MediaStream,
  o: {
    maxSeconds: number
    onDone: (r: ClipResult) => void
    Recorder?: RecorderCtor
    isSupported?: (type: string) => boolean
    fix?: (blob: Blob, ms: number) => Promise<Blob>
  },
): { stop: () => void } {
  const Recorder = o.Recorder ?? (MediaRecorder as unknown as RecorderCtor)
  const isSupported = o.isSupported ?? ((t: string) => MediaRecorder.isTypeSupported(t))
  const fix = o.fix ?? ((b: Blob, ms: number) => fixWebmDuration(b, ms, { logger: false }))
  const mimeType = pickMimeType(isSupported)
  const rec = new Recorder(stream, { mimeType, videoBitsPerSecond: CLIP_BITS_PER_SECOND })
  const chunks: Blob[] = []
  const started = Date.now()
  let reason: ClipResult['reason'] = 'stopped'
  let finished = false
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  rec.onstop = () => {
    if (finished) return
    finished = true
    clearTimeout(hard)
    for (const t of stream.getTracks()) t.stop()
    const durationMs = Date.now() - started
    void fix(new Blob(chunks, { type: mimeType.split(';')[0] }), durationMs)
      .catch(() => new Blob(chunks, { type: 'video/webm' }))
      .then((blob) => o.onDone({ blob, durationMs, reason }))
  }
  const stop = (why: ClipResult['reason']) => {
    if (rec.state === 'inactive' || finished) return
    reason = why
    rec.stop()
  }
  const hard = setTimeout(() => stop('max'), o.maxSeconds * 1000)
  // The tab closing ends the capture track (navigation does not: the worker watches that).
  for (const t of stream.getTracks() as (MediaStreamTrack & { onended?: unknown })[]) {
    if ('onended' in t || typeof (t as { addEventListener?: unknown }).addEventListener === 'function') (t as MediaStreamTrack).onended = () => stop('ended')
  }
  rec.start(1000)
  return { stop: () => stop('stopped') }
}
