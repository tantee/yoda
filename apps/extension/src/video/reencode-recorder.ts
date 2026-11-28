import fixWebmDuration from 'fix-webm-duration'
import { mosaicFrame, type Reencode } from './regions'
import { readWebm } from './webm-reader'

const REPAINT_MS = 33
const abortError = () => new DOMException('cancelled', 'AbortError')

/** Frames in a WebM, or null when the file cannot be read (then the caller's own count stands). */
async function countFrames(blob: Blob): Promise<number | null> {
  try {
    return readWebm(await blob.arrayBuffer()).frames.length
  } catch {
    return null
  }
}

/** Loads the clip's metadata; a clip without a written duration is sought to its end once so the duration is known. */
async function load(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  const once = (ev: string) =>
    new Promise<void>((res, rej) => {
      const fail = () => rej(video.error ?? new Error('video error'))
      video.addEventListener(ev, () => (video.removeEventListener('error', fail), res()), { once: true })
      video.addEventListener('error', fail, { once: true })
      signal.addEventListener('abort', () => rej(abortError()), { once: true })
    })
  if (video.readyState < 1) await once('loadedmetadata')
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e9
    await once('durationchange')
    video.currentTime = 0
    await once('seeked')
  }
}

/**
 * Path 1 (decision 1): the clip plays at 1x in a <video>; each frame (requestVideoFrameCallback) is drawn on the
 * visible preview canvas, the active regions are pixelated there, and the canvas is recorded with MediaRecorder.
 * A hidden tab stops frame callbacks, so the source and the recorder pause until the tab is visible again.
 * framesIn is counted in the source file; framesOut is the source frames that reached the canvas (playback can
 * skip some when the tab is busy).
 */
export const reencodeWithRecorder: Reencode = async (src, regions, opts) => {
  const { preview, signal } = opts
  if (typeof MediaRecorder === 'undefined' || !('requestVideoFrameCallback' in HTMLVideoElement.prototype) || !('captureStream' in preview)) throw new Error('unsupported')
  if (!MediaRecorder.isTypeSupported(opts.mimeType)) throw new Error('unsupported')
  if (signal.aborted) throw abortError()

  const url = URL.createObjectURL(src)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.src = url
  let stream: MediaStream | null = null
  let onVisibility: (() => void) | null = null
  try {
    await load(video, signal)
    const durationMs = video.duration * 1000
    preview.width = video.videoWidth
    preview.height = video.videoHeight
    const ctx = preview.getContext('2d', { willReadFrequently: true })!
    stream = preview.captureStream(0)
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
    const rec = new MediaRecorder(stream, { mimeType: opts.mimeType, videoBitsPerSecond: opts.bitsPerSecond })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    let painted = 0
    let presented = 0
    let lastPaint = 0
    let finished = false
    // The last source frame, as drawn in the frame callback, and its exact media time. The repaint below reuses it:
    // video.currentTime is not frame-accurate, so drawing the <video> again could show a newer frame with the
    // regions of an older time (a region's first frame unmosaicked).
    const last = new OffscreenCanvas(preview.width, preview.height)
    const lastCtx = last.getContext('2d')!
    let lastMs = -1
    const paint = (...times: number[]) => {
      ctx.drawImage(last, 0, 0)
      // Every region active at any of the times: the held frame keeps its own regions, and gains one that starts.
      for (const t of times) mosaicFrame(ctx, regions, t)
      const ms = Math.max(...times)
      track.requestFrame()
      lastPaint = performance.now()
      opts.onProgress(Math.min(1, ms / durationMs))
    }
    const done = new Promise<void>((resolve, reject) => {
      const draw = (_now: number, meta: VideoFrameCallbackMetadata) => {
        lastCtx.drawImage(video, 0, 0, preview.width, preview.height)
        lastMs = meta.mediaTime * 1000
        paint(lastMs)
        painted++
        presented = meta.presentedFrames
        if (!video.ended) video.requestVideoFrameCallback(draw)
      }
      video.requestVideoFrameCallback(draw)
      // A static page gives few source frames, and a realtime encoder cleans up a changed area over several frames:
      // the last frame is painted again at about 30 fps, so a region starts and ends on time and its first frames
      // carry no leftovers of the stripes underneath. The held frame keeps the regions of its own time, and a region
      // starting between source frames covers it from the region's start.
      const tick = (now: number) => {
        if (finished) return
        if (lastMs >= 0 && !video.paused && !video.ended && now - lastPaint >= REPAINT_MS) paint(lastMs, video.currentTime * 1000)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      video.addEventListener('ended', () => (rec.state !== 'inactive' ? rec.stop() : resolve()), { once: true })
      video.addEventListener('error', () => reject(video.error ?? new Error('video error')), { once: true })
      rec.onstop = () => resolve()
      rec.onerror = (e) => reject((e as ErrorEvent).error ?? new Error('recorder error'))
      signal.addEventListener(
        'abort',
        () => {
          video.pause()
          if (rec.state !== 'inactive') rec.stop()
          reject(abortError())
        },
        { once: true },
      )
    })
    onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        video.pause()
        if (rec.state === 'recording') rec.pause()
      } else if (!video.ended && !signal.aborted) {
        if (rec.state === 'paused') rec.resume()
        void video.play()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    rec.start(1000)
    if (document.visibilityState === 'hidden') onVisibility()
    else await video.play()
    await done.finally(() => (finished = true))
    opts.onProgress(1)

    const raw = new Blob(chunks, { type: 'video/webm' })
    const blob = await fixWebmDuration(raw, durationMs, { logger: false }).catch(() => raw)
    if (!(await countFrames(blob))) throw new Error('the recorder wrote no frames')
    return { blob, framesIn: (await countFrames(src)) ?? presented, framesOut: painted }
  } finally {
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
    for (const t of stream?.getTracks() ?? []) t.stop()
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
