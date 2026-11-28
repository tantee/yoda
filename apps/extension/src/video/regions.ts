import type { Img, Rect } from '../editor/pixels'
import { pixelate } from '../editor/pixels'

/** A mosaic rectangle on the clip over a time range (decision 1). `rect` is in video pixels. */
export type VideoRegion = { id: string; rect: Rect; fromMs: number; toMs: number; block: number }

export type ReencodeOpts = {
  mimeType: string
  bitsPerSecond: number
  onProgress: (p: number) => void
  signal: AbortSignal
  preview: HTMLCanvasElement
}
export type ReencodeResult = { blob: Blob; framesIn: number; framesOut: number }
export type Reencode = (src: Blob, regions: VideoRegion[], opts: ReencodeOpts) => Promise<ReencodeResult>

export type MosaicResult =
  | { ok: true; blob: Blob; path: 'recorder' | 'webcodecs'; framesIn: number; framesOut: number }
  | { ok: false; cancelled?: true }

/** The regions covering time `tMs`: `fromMs` inclusive, `toMs` exclusive. */
export function activeRegions(regions: VideoRegion[], tMs: number): VideoRegion[] {
  return regions.filter((r) => tMs >= r.fromMs && tMs < r.toMs)
}

/**
 * Regions drawn on the buffer's joined timeline (segment 1, then segment 2), as regions per segment with the
 * segment's own times. A region over the boundary is split: one part in each segment, so nothing it hides shows.
 */
export function splitRegions(regions: VideoRegion[], segmentDurationsMs: number[]): VideoRegion[][] {
  let offset = 0
  return segmentDurationsMs.map((d) => {
    const from = offset
    const to = offset + d
    offset = to
    return regions
      .filter((r) => r.fromMs < to && r.toMs > from)
      .map((r) => ({ ...r, rect: { ...r.rect }, fromMs: Math.max(r.fromMs, from) - from, toMs: Math.min(r.toMs, to) - from }))
  })
}

/** A re-encode that keeps under 90% of the source frames is refused: the next path is tried, or the fallback. */
export function acceptReencode(r: { framesIn: number; framesOut: number }): 'ok' | 'too_lossy' {
  return r.framesIn > 0 && r.framesOut / r.framesIn >= 0.9 ? 'ok' : 'too_lossy'
}

/**
 * The regions to burn into a still frame shown at `seekMs`: every region active anywhere in the second before it
 * (the frame shown is the last one at or before the seek, at an unknown earlier time) or at the requested time.
 * Hiding a little too much is fine; missing a region is not.
 */
export function regionsForStill(regions: VideoRegion[], seekMs: number, requestedMs: number): VideoRegion[] {
  const from = Math.min(seekMs, requestedMs) - 1000
  const to = Math.max(seekMs, requestedMs)
  return regions.filter((r) => r.fromMs <= to && r.toMs > from)
}

/** Scales a region rect from the video size it was drawn on to a frame of another size (a tab resized mid-clip). */
export function scaleRect(rect: { x: number; y: number; w: number; h: number }, from: { w: number; h: number }, to: { w: number; h: number }) {
  const sx = from.w ? to.w / from.w : 1
  const sy = from.h ? to.h / from.h : 1
  const x = Math.floor(rect.x * sx)
  const y = Math.floor(rect.y * sy)
  return { x, y, w: Math.ceil((rect.x + rect.w) * sx) - x, h: Math.ceil((rect.y + rect.h) * sy) - y }
}

/** Pixelates the regions active at `tMs` on a 2D context of the video's size, with the image editor's mosaic. */
export function mosaicFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, regions: VideoRegion[], tMs: number): void {
  for (const r of activeRegions(regions, tMs)) {
    const x = Math.max(0, Math.floor(r.rect.x))
    const y = Math.max(0, Math.floor(r.rect.y))
    // Whole pixels covering the fractional rect: from the floor of its start to the ceiling of its end.
    const w = Math.min(ctx.canvas.width, Math.ceil(r.rect.x + r.rect.w)) - x
    const h = Math.min(ctx.canvas.height, Math.ceil(r.rect.y + r.rect.h)) - y
    if (w <= 0 || h <= 0) continue
    const data = ctx.getImageData(x, y, w, h)
    const img: Img = { data: data.data, width: w, height: h }
    pixelate(img, { x: 0, y: 0, w, h }, r.block)
    ctx.putImageData(data, x, y)
  }
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Burns the regions into the clip: WebCodecs first (frame-exact, about 7x faster, and it does not need the tab
 * visible: see "Video re-encode measurement" in docs/design/extension-spike.md), then MediaRecorder on the visible
 * preview when WebCodecs throws, is unsupported, or keeps too few frames. `{ ok: false }` when neither is good
 * enough; the caller then offers only "send without video" or "use a still frame".
 */
export async function applyVideoMosaic(
  src: Blob,
  regions: VideoRegion[],
  opts: ReencodeOpts,
  paths: { recorder: Reencode; webcodecs: Reencode } = { recorder: defaultRecorder, webcodecs: defaultWebCodecs },
): Promise<MosaicResult> {
  for (const path of ['webcodecs', 'recorder'] as const) {
    if (opts.signal.aborted) return { ok: false, cancelled: true }
    try {
      const r = await paths[path](src, regions, opts)
      if (acceptReencode(r) === 'ok') return { ok: true, blob: r.blob, path, framesIn: r.framesIn, framesOut: r.framesOut }
      console.warn(`mosaic: the ${path} path kept ${r.framesOut} of ${r.framesIn} frames`)
    } catch (e) {
      if (isAbort(e) || opts.signal.aborted) return { ok: false, cancelled: true }
      console.warn(`mosaic: the ${path} path failed`, e)
    }
  }
  return { ok: false }
}

// Loaded on first use: the editor of a screenshot-only report never pulls the video code.
const defaultRecorder: Reencode = async (...a) => (await import('./reencode-recorder')).reencodeWithRecorder(...a)
const defaultWebCodecs: Reencode = async (...a) => (await import('./reencode-webcodecs')).reencodeWithWebCodecs(...a)
