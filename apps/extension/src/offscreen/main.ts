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
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId, maxWidth: 1280, maxHeight: 1280, maxFrameRate: 30 } } as unknown as MediaTrackConstraints,
  })
  const tabId = m.tabId
  clip = recordClip(stream, {
    maxSeconds: m.maxSeconds,
    onDone: (r) => {
      clip = null
      const id = crypto.randomUUID()
      void putClip({ id, tabId, blob: r.blob, durationMs: r.durationMs, createdAt: Date.now() }).then(() =>
        chrome.runtime.sendMessage({ type: 'video.done', clipId: id, tabId, durationMs: r.durationMs, reason: r.reason }),
      )
    },
  })
  return { ok: true }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  // Only the extension's own worker drives the recorder.
  if (sender.id !== chrome.runtime.id) return false
  const p = route(m, { clip: clipJob })
  if (!p) return false
  p.then(reply, (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})
