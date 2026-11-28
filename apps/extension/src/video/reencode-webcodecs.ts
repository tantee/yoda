import { ArrayBufferTarget, Muxer } from 'webm-muxer'
import { activeRegions, mosaicFrame, type Reencode } from './regions'
import { readWebm } from './webm-reader'

/** WebCodecs strings for the WebM codec IDs MediaRecorder writes; the output keeps the same codec. */
const CODECS: Record<string, string> = { V_VP8: 'vp8', V_VP9: 'vp09.00.10.08' }
/** A key frame every 2 s at 30 fps keeps the output seekable. */
const KEY_EVERY = 60
const QUEUE_MAX = 8

const abortError = () => new DOMException('cancelled', 'AbortError')

/**
 * Path 2 (decision 1): demux the clip (readWebm), decode each frame, pixelate the active regions on a canvas,
 * encode it again with the same codec and bitrate, and mux it with webm-muxer. Frame-exact: it does not depend on
 * playback timing or on the tab being visible. Each frame is also drawn on the preview so progress can be seen.
 * framesOut counts the source frames written (not the frames added at region boundaries).
 */
export const reencodeWithWebCodecs: Reencode = async (src, regions, opts) => {
  const { signal } = opts
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') throw new Error('unsupported')
  const webm = readWebm(await src.arrayBuffer())
  const codec = CODECS[webm.codec]
  if (!codec) throw new Error(`unsupported codec ${webm.codec}`)
  const { width, height } = webm
  const span = webm.frames.at(-1)!.timestampUs - webm.frames[0]!.timestampUs
  const framerate = span > 0 ? Math.round(((webm.frames.length - 1) * 1e6) / span) : 30
  const encConfig: VideoEncoderConfig = { codec, width, height, bitrate: opts.bitsPerSecond, framerate: Math.max(1, framerate), latencyMode: 'quality' }
  const decConfig: VideoDecoderConfig = { codec, codedWidth: width, codedHeight: height }
  if (!(await VideoEncoder.isConfigSupported(encConfig)).supported || !(await VideoDecoder.isConfigSupported(decConfig)).supported) throw new Error('unsupported')
  if (signal.aborted) throw abortError()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // The last decoded frame, unmasked, to repeat at a region boundary that falls between two source frames.
  const last = new OffscreenCanvas(width, height)
  const lastCtx = last.getContext('2d')!
  opts.preview.width = width
  opts.preview.height = height
  const shown = opts.preview.getContext('2d')
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: webm.codec, width, height, frameRate: framerate }, firstTimestampBehavior: 'offset' })
  let failure: unknown = null
  let framesOut = 0
  let encoded = 0
  let decoded = 0
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta)
      framesOut++
    },
    error: (e) => (failure ??= e),
  })
  encoder.configure(encConfig)

  // A key frame wherever the set of regions changes: a delta frame at a low bitrate can leave blocks of what is
  // underneath for several frames.
  let shownKey: string | null = null
  const emit = (timestampUs: number) => {
    ctx.drawImage(last, 0, 0)
    mosaicFrame(ctx, regions, timestampUs / 1000)
    const key = activeRegions(regions, timestampUs / 1000).map((r) => r.id).join()
    const out = new VideoFrame(canvas, { timestamp: timestampUs })
    try {
      encoder.encode(out, { keyFrame: encoded % KEY_EVERY === 0 || key !== shownKey })
    } finally {
      out.close()
    }
    shownKey = key
    encoded++
    shown?.drawImage(canvas, 0, 0)
  }
  // A static page gives few frames: without a frame at each region start and end, a region could start and end
  // between two source frames and never be burned in, or stay on after its end.
  const boundaries = [...new Set(regions.flatMap((r) => [r.fromMs, r.toMs]))].map((ms) => ms * 1000).sort((a, b) => a - b)
  let nextBoundary = 0
  let inserted = 0
  let lastTs = -1
  const boundariesBefore = (ts: number) => {
    while (nextBoundary < boundaries.length && boundaries[nextBoundary]! < ts) {
      const b = boundaries[nextBoundary++]!
      if (lastTs >= 0 && b > lastTs) {
        emit(b)
        inserted++
      }
    }
  }
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        boundariesBefore(frame.timestamp)
        lastCtx.drawImage(frame, 0, 0, width, height)
        emit(frame.timestamp)
        lastTs = frame.timestamp
        decoded++
        opts.onProgress(decoded / webm.frames.length)
      } catch (e) {
        failure ??= e
      } finally {
        frame.close()
      }
    },
    error: (e) => (failure ??= e),
  })
  decoder.configure(decConfig)

  // Wait while the codec queues are full, so a 30 s clip is never all decoded into memory at once.
  const drain = () =>
    new Promise<void>((res) => {
      if (decoder.decodeQueueSize < QUEUE_MAX && encoder.encodeQueueSize < QUEUE_MAX) return res()
      const target = decoder.decodeQueueSize >= QUEUE_MAX ? decoder : encoder
      target.addEventListener('dequeue', () => res(), { once: true })
    })
  try {
    for (const f of webm.frames) {
      if (signal.aborted) throw abortError()
      if (failure) throw failure
      await drain()
      decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestampUs, data: f.data }))
    }
    await decoder.flush()
    if (webm.durationUs) boundariesBefore(webm.durationUs)
    await encoder.flush()
    if (failure) throw failure
    if (signal.aborted) throw abortError()
    muxer.finalize()
    return { blob: new Blob([muxer.target.buffer], { type: 'video/webm' }), framesIn: webm.frames.length, framesOut: framesOut - inserted }
  } finally {
    if (decoder.state !== 'closed') decoder.close()
    if (encoder.state !== 'closed') encoder.close()
  }
}
