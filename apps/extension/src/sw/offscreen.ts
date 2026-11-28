import { readPolicy } from './policy'
import { productionVerdict } from './rules'

/**
 * The single offscreen document (decision 16) and its jobs. The worker never holds a recording: the document does,
 * and its own timer stops a clip at the limit even while the worker sleeps. Job state lives in storage.session, so
 * a restarted worker still knows what runs.
 */

export const OFFSCREEN_URL = 'src/offscreen/index.html'
const JOBS = 'offscreen.jobs'

export type ClipJob = {
  tabId: number
  profileId: string
  projectId?: string
  attach?: { console: boolean; network: boolean }
  startedAt: number
  maxSeconds: number
  /** The page the clip started on (the tab may be gone, or its URL unreadable, by the end). */
  url: string
  /** The tab navigated to a page not known to be safe: the video is discarded. */
  tainted: boolean
}
/** The replay buffer (D1, sw/buffer.ts): which tab, since when, and what the report starts from. Never any video. */
export type BufferJob = {
  tabId: number
  profileId: string
  projectId?: string
  attach?: { console: boolean; network: boolean }
  startedAt: number
  /** The page it was armed on. */
  url: string
}
export type Jobs = { clip?: ClipJob; buffer?: BufferJob }

export async function jobs(): Promise<Jobs> {
  return ((await chrome.storage.session.get(JOBS))[JOBS] as Jobs | undefined) ?? {}
}

export async function setJobs(j: Jobs): Promise<void> {
  await chrome.storage.session.set({ [JOBS]: j })
}

let creating: Promise<void> | null = null

/** Creates the offscreen document unless it exists (one per extension; concurrent callers share one creation). */
export async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
  if (existing.length) return
  creating ??= chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['USER_MEDIA' as chrome.offscreen.Reason], justification: 'Records the tab for a defect report (clip or replay buffer).' })
    .finally(() => {
      creating = null
    })
  await creating
}

/** Closes the document when neither a clip nor the buffer runs. */
export async function closeOffscreenIfIdle(): Promise<boolean> {
  const j = await jobs()
  if (j.clip || j.buffer) return false
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
  if (!existing.length) return false
  await chrome.offscreen.closeDocument()
  return true
}

export type StartClip = { tabId: number; profileId: string; projectId?: string; attach?: { console: boolean; network: boolean }; maxSeconds: number }
export type StartError = 'production' | 'unknown_page' | 'busy' | 'capture_failed' | 'policy'

/** The clip's frame: the tab's size scaled to at most 1280 wide, even numbers (VP8/VP9 need them). */
export function clipSize(tab: { width?: number; height?: number }): { width?: number; height?: number } {
  if (!tab.width || !tab.height) return {}
  const scale = Math.min(1, 1280 / tab.width)
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(tab.width), height: even(tab.height) }
}

/** Starts (of a clip or the buffer) run one at a time: two clicks must not both pass the busy check. */
let lock: Promise<unknown> = Promise.resolve()
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn)
  lock = next.catch(() => {})
  return next
}

/**
 * A job whose document is gone (extension reload, crash) or that outlived its hard stop by a minute never sends
 * video.done: forget it, so the next clip is not refused as busy.
 */
export async function clearStaleClip(now = Date.now()): Promise<void> {
  const j = await jobs()
  if (!j.clip) return
  const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
  if (!docs.length || now > j.clip.startedAt + (j.clip.maxSeconds + 60) * 1000) await endClip()
}

/**
 * Starts a clip of a tab. Refused unless the worker's rules say the page is not production (an unreadable URL or
 * never-fetched mappings count as unknown), and while another clip runs. The popup has asked for tabCapture
 * already, in its click.
 */
export function startClip(o: StartClip): Promise<{ ok: true } | { ok: false; error: StartError }> {
  return serial(async () => {
    // IT can turn video off for everyone (managed policy allowVideo).
    if (!(await readPolicy()).policy.allowVideo) return { ok: false, error: 'policy' }
    const tab = await chrome.tabs.get(o.tabId)
    const url = tab.url ?? ''
    const verdict = await productionVerdict(url).catch(() => 'unknown' as const)
    if (verdict !== 'ok') return { ok: false, error: verdict === 'production' ? 'production' : 'unknown_page' }
    await clearStaleClip()
    const j = await jobs()
    if (j.clip) return { ok: false, error: 'busy' }
    let streamId: string
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: o.tabId })
    } catch {
      return { ok: false, error: 'capture_failed' }
    }
    await setJobs({ ...j, clip: { tabId: o.tabId, profileId: o.profileId, projectId: o.projectId, attach: o.attach, startedAt: Date.now(), maxSeconds: o.maxSeconds, url, tainted: false } })
    await ensureOffscreen()
    const r = (await chrome.runtime.sendMessage({ target: 'offscreen', job: 'clip', type: 'start', streamId, tabId: o.tabId, maxSeconds: o.maxSeconds, ...clipSize(tab) }).catch(() => null)) as { ok?: boolean } | null
    if (!r?.ok) {
      await endClip()
      return { ok: false, error: 'capture_failed' }
    }
    return { ok: true }
  })
}

export async function stopClip(): Promise<void> {
  await clearStaleClip()
  if ((await jobs()).clip) await chrome.runtime.sendMessage({ target: 'offscreen', job: 'clip', type: 'stop' }).catch(() => undefined)
}

/**
 * The clip's tab started loading a page. tabCapture keeps recording across navigation, so a page that is not known
 * to be safe (production, or a URL the extension cannot read) taints the clip: it is stopped now and its video is
 * never kept.
 */
export async function onClipTabNavigated(tabId: number, url: string | undefined): Promise<void> {
  const j = await jobs()
  if (!j.clip || j.clip.tabId !== tabId || j.clip.tainted) return
  const verdict = await productionVerdict(url ?? '').catch(() => 'unknown' as const)
  if (verdict === 'ok') return
  await setJobs({ ...j, clip: { ...j.clip, tainted: true } })
  await stopClip()
}

/** The clip job is over (done or failed): forget it, and close the document if nothing else runs. */
export async function endClip(): Promise<ClipJob | null> {
  const j = await jobs()
  const clip = j.clip ?? null
  delete j.clip
  await setJobs(j)
  await closeOffscreenIfIdle().catch(() => false)
  return clip
}
