/** One frame of the clip at `tMs`, for the fallback "use a still frame" (decision 1). The caller closes the bitmap. */
export async function stillFrame(src: Blob, tMs: number): Promise<ImageBitmap> {
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
    video.currentTime = Math.max(0, Math.min(tMs / 1000, end - 0.001))
    await wait('seeked')
    return await createImageBitmap(video)
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
