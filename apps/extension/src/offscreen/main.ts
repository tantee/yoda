// The one offscreen document (plan decision 16): clips (C1) and the replay buffer (D1) record here.
import { putClip } from '../drafts/clips'
import { recordClip } from './recorder'
import { route, type OffscreenMsg } from './router'

let clip: { stop: () => void } | null = null

async function clipJob(m: OffscreenMsg): Promise<unknown> {
  if (m.job !== 'clip') return { ok: false }
  if (m.type === 'stop') {
    clip?.stop()
    return { ok: true }
  }
  if (clip) return { ok: false, error: 'busy' }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // The tab's own shape (at most 1280 wide): without min and max sizes Chrome letterboxes it into a square.
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: m.streamId,
        ...(m.width && m.height ? { minWidth: m.width, maxWidth: m.width, minHeight: m.height, maxHeight: m.height } : { maxWidth: 1280, maxHeight: 1280 }),
        maxFrameRate: 30,
      },
    } as unknown as MediaTrackConstraints,
  })
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

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only the extension's own worker drives the recorder.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false
  const p = route(m, { clip: clipJob })
  if (!p) return false
  p.then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})
