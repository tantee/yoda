import { allRules } from './rules'
import { isProduction } from '../rules/match'

/**
 * The single offscreen document (decision 16) and its jobs. The worker never holds a recording: the document does,
 * and its own timer stops a clip at the limit even while the worker sleeps. Job state lives in storage.session, so
 * a restarted worker still knows what runs.
 */

export const OFFSCREEN_URL = 'src/offscreen/index.html'
const JOBS = 'offscreen.jobs'

export type ClipJob = { tabId: number; profileId: string; projectId?: string; attach?: { console: boolean; network: boolean }; startedAt: number }
export type Jobs = { clip?: ClipJob; buffer?: { tabId: number; startedAt: number } }

export async function jobs(): Promise<Jobs> {
  return ((await chrome.storage.session.get(JOBS))[JOBS] as Jobs | undefined) ?? {}
}

async function setJobs(j: Jobs): Promise<void> {
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

/**
 * Starts a clip of a tab. Refused on a production site (the worker's rules decide, not the caller), and while
 * another clip runs. The popup has asked for tabCapture already, in its click.
 */
export async function startClip(o: StartClip): Promise<{ ok: true } | { ok: false; error: 'production' | 'busy' | 'capture_failed' }> {
  const tab = await chrome.tabs.get(o.tabId)
  if (isProduction(tab.url ?? '', await allRules().catch(() => []))) return { ok: false, error: 'production' }
  const j = await jobs()
  if (j.clip) return { ok: false, error: 'busy' }
  let streamId: string
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: o.tabId })
  } catch {
    return { ok: false, error: 'capture_failed' }
  }
  await setJobs({ ...j, clip: { tabId: o.tabId, profileId: o.profileId, projectId: o.projectId, attach: o.attach, startedAt: Date.now() } })
  await ensureOffscreen()
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', job: 'clip', type: 'start', streamId, tabId: o.tabId, maxSeconds: o.maxSeconds })) as { ok?: boolean } | undefined
  if (!r?.ok) {
    await endClip()
    return { ok: false, error: 'capture_failed' }
  }
  return { ok: true }
}

export async function stopClip(): Promise<void> {
  if ((await jobs()).clip) await chrome.runtime.sendMessage({ target: 'offscreen', job: 'clip', type: 'stop' })
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
