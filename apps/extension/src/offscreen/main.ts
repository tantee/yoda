// The one offscreen document (plan decision 16): clips (C1) and the replay buffer (D1) record here.
import { putClip } from '../drafts/clips'
import { bufferJob } from './buffer'
import { recordClip } from './recorder'
import { route, type OffscreenMsg } from './router'

let clip: { stop: () => void } | null = null

/** The tab's capture stream, in the tab's own shape (at most 1280 wide). */
function tabStream(m: { streamId: string; width?: number; height?: number }): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // Without min and max sizes Chrome letterboxes the tab into a square.
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: m.streamId,
        ...(m.width && m.height ? { minWidth: m.width, maxWidth: m.width, minHeight: m.height, maxHeight: m.height } : { maxWidth: 1280, maxHeight: 1280 }),
        maxFrameRate: 30,
      },
    } as unknown as MediaTrackConstraints,
  })
}

async function clipJob(m: OffscreenMsg): Promise<unknown> {
  if (m.job !== 'clip') return { ok: false }
  if (m.type === 'stop') {
    clip?.stop()
    return { ok: true }
  }
  if (clip) return { ok: false, error: 'busy' }
  const stream = await tabStream(m)
  const tabId = m.tabId
  try {
    clip = recordClip(stream, {
      maxSeconds: m.maxSeconds,
      onDone: (r) => {
        clip = null
        const id = crypto.randomUUID()
        void putClip({ id, tabId, blob: r.blob, durationMs: r.durationMs, createdAt: Date.now() }).then(
          () => chrome.runtime.sendMessage({ type: 'video.done', clipId: id, tabId, durationMs: r.durationMs, reason: r.reason }),
          () => chrome.runtime.sendMessage({ type: 'video.failed', tabId }),
        )
      },
    })
  } catch (e) {
    // The recorder never started: release the tab capture.
    for (const t of stream.getTracks()) t.stop()
    throw e
  }
  return { ok: true }
}

// The buffer's segments stay in this document's memory until a save; its own timer disarms it after 15 minutes.
const buffer = bufferJob({ stream: tabStream, send: (m) => chrome.runtime.sendMessage(m), putClip })

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only the extension's own worker drives the recorder.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false
  const p = route(m, { clip: clipJob, buffer })
  if (!p) return false
  p.then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})
