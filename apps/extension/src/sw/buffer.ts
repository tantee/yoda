import { pickRule } from '../rules/match'
import { BUFFER_MAX_MS } from '../offscreen/router'
import { deleteClip, getClip } from '../drafts/clips'
import { clipSize, closeOffscreenIfIdle, ensureOffscreen, jobs, serial, setJobs, type BufferJob } from './offscreen'
import { readPolicy } from './policy'
import { startReport } from './report-start'
import { allRules, productionVerdict } from './rules'

/**
 * The replay buffer (D1) from the worker's side. The offscreen document holds the last 30–60 s in memory; the
 * worker only decides where it may run (a mapped page known not to be production, policy permitting), keeps the
 * job in storage.session, shows the red badge, and disarms it when the tab leaves the mapped site, reaches
 * production or closes. Every check fails closed.
 */
export type DisarmReason = 'saved' | 'timeout' | 'left_mapped_site' | 'production' | 'tab_closed' | 'user'
export type ArmError = 'policy' | 'production' | 'unknown_page' | 'not_mapped' | 'busy' | 'capture_failed'
export type ArmBuffer = {
  tabId: number
  profileId: string
  projectId?: string
  attach?: { console: boolean; network: boolean }
  /** e2e builds only (sw/index.ts drops it otherwise): shorter segments, to see a rotation in a real browser. */
  segmentMs?: number
}

/** The error colour of the extension's theme. */
const RED = '#B3261E'

const policyAllows = async () => {
  const { policy } = await readPolicy()
  return policy.allowVideo && policy.allowBuffer
}

/** Whether the buffer may run on `url`: video allowed (`ok`) and a mapping rule for the page. */
async function verdictFor(url: string): Promise<'ok' | 'production' | 'unknown_page' | 'not_mapped'> {
  const verdict = await productionVerdict(url).catch(() => 'unknown' as const)
  if (verdict === 'production') return 'production'
  if (verdict !== 'ok') return 'unknown_page'
  const rule = pickRule(url, await allRules().catch(() => []))
  return rule && !rule.rule.production ? 'ok' : 'not_mapped'
}

async function badge(tabId: number, on: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: on ? '●' : '', tabId }).catch(() => {})
  if (on) await chrome.action.setBadgeBackgroundColor({ color: RED, tabId }).catch(() => {})
}

/** Forgets the job (re-read first: a clip may have changed meanwhile), clears the badge, closes an idle document. */
async function forget(job: BufferJob): Promise<void> {
  const j = await jobs()
  if (j.buffer && j.buffer.tabId === job.tabId && j.buffer.startedAt === job.startedAt) {
    delete j.buffer
    await setJobs(j)
  }
  await badge(job.tabId, false)
  await closeOffscreenIfIdle().catch(() => false)
}

/** A job whose document is gone (extension reload, crash), or that outlived its 15 minutes, is forgotten. */
export async function clearStaleBuffer(now = Date.now()): Promise<void> {
  const j = await jobs()
  if (!j.buffer) return
  const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
  if (!docs.length) await forget(j.buffer)
  else if (now > j.buffer.startedAt + BUFFER_MAX_MS + 60_000) await disarmBuffer('timeout')
}

export async function bufferState(): Promise<BufferJob | null> {
  await clearStaleBuffer()
  return (await jobs()).buffer ?? null
}

/** Arms the buffer on a tab. The popup has asked for tabCapture already, in its click. */
export function armBuffer(o: ArmBuffer): Promise<{ ok: true } | { ok: false; error: ArmError }> {
  return serial(async () => {
    if (!(await policyAllows())) return { ok: false, error: 'policy' }
    const tab = await chrome.tabs.get(o.tabId)
    const url = tab.url ?? ''
    const v = await verdictFor(url)
    if (v !== 'ok') return { ok: false, error: v }
    await clearStaleBuffer()
    const j = await jobs()
    if (j.buffer) return { ok: false, error: 'busy' }
    let streamId: string
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: o.tabId })
    } catch {
      return { ok: false, error: 'capture_failed' }
    }
    const job: BufferJob = { tabId: o.tabId, profileId: o.profileId, projectId: o.projectId, attach: o.attach, startedAt: Date.now(), url }
    await setJobs({ ...j, buffer: job })
    await ensureOffscreen()
    const r = (await chrome.runtime.sendMessage({ target: 'offscreen', job: 'buffer', type: 'start', streamId, tabId: o.tabId, ...clipSize(tab), ...(o.segmentMs ? { segmentMs: o.segmentMs } : {}) }).catch(() => null)) as { ok?: boolean } | null
    if (!r?.ok) {
      await forget(job)
      return { ok: false, error: 'capture_failed' }
    }
    await badge(o.tabId, true)
    return { ok: true }
  })
}

/** Stops the buffer: the document discards its memory, the badge and the job go, the document closes if idle. */
export async function disarmBuffer(_reason: DisarmReason): Promise<boolean> {
  const j = await jobs()
  if (!j.buffer) return false
  await chrome.runtime.sendMessage({ target: 'offscreen', job: 'buffer', type: 'stop' }).catch(() => undefined)
  await forget(j.buffer)
  return true
}

/** The document disarmed itself (15 minutes, or the capture ended). */
export function onBufferDisarmed(reason: DisarmReason): Promise<boolean> {
  return disarmBuffer(reason)
}

/**
 * The buffer's tab started loading a page. tabCapture keeps recording across navigation, so anything but a mapped
 * page known not to be production (an unreadable URL included) disarms it at once.
 */
export async function onBufferTabNavigated(tabId: number, url: string | undefined): Promise<void> {
  const j = await jobs()
  if (!j.buffer || j.buffer.tabId !== tabId) return
  const v = await verdictFor(url ?? '')
  if (v === 'production') await disarmBuffer('production')
  else if (v !== 'ok') await disarmBuffer('left_mapped_site')
  // Still armed: keep the badge on the new page.
  else await badge(tabId, true)
}

export async function onBufferTabRemoved(tabId: number): Promise<void> {
  const j = await jobs()
  if (j.buffer?.tabId === tabId) await disarmBuffer('tab_closed')
}

/**
 * Saves the last 30–60 s into a new draft and opens the editor. The document stops recording and hands over its
 * segments as clips (IndexedDB, only now); the buffer is disarmed; the clips go once the draft holds them.
 */
export async function saveBuffer(): Promise<{ ok: true; draftId: string } | { ok: false; error: 'not_armed' | 'save_failed' }> {
  await clearStaleBuffer()
  const job = (await jobs()).buffer
  if (!job) return { ok: false, error: 'not_armed' }
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', job: 'buffer', type: 'save' }).catch(() => null)) as { ok?: boolean; clips?: string[] } | null
  await disarmBuffer('saved')
  const ids = r?.ok && Array.isArray(r.clips) ? r.clips : []
  try {
    const clips = (await Promise.all(ids.map((id) => getClip(id)))).filter((c) => !!c && c.tabId === job.tabId)
    if (!clips.length) return { ok: false, error: 'save_failed' }
    const d = await startReport({ tabId: job.tabId, profileId: job.profileId, kind: 'buffer', projectId: job.projectId, attach: job.attach, buffer: clips.map((c) => c!.blob), url: job.url })
    return { ok: true, draftId: d.draftId }
  } finally {
    // Only once the draft holds them (or has discarded them).
    for (const id of ids) await deleteClip(id).catch(() => {})
  }
}
