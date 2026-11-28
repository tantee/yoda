/**
 * One frame of the clip at about `tMs`, for the fallback "use a still frame" (decision 1), and the time actually
 * sought (the frame shown is the last one at or before it). The caller closes the bitmap.
 */
export async function stillFrame(src: Blob, tMs: number): Promise<{ bitmap: ImageBitmap; seekMs: number }> {
  const url = URL.createObjectURL(src)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url
  const wait = (ev: string) =>
    new Promise<void>((res, rej) => {
      video.addEventListener(ev, () => res(), { once: true })
      video.addEventListener('error', () => rej(video.error ?? new Error('video error')), { once: true })
    })
  try {
    if (video.readyState < 1) await wait('loadedmetadata')
    const end = Number.isFinite(video.duration) ? video.duration : tMs / 1000
    const seek = Math.max(0, Math.min(tMs / 1000, end - 0.001))
    video.currentTime = seek
    await wait('seeked')
    return { bitmap: await createImageBitmap(video), seekMs: seek * 1000 }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
