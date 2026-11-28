import { captureFullPage, captureVisible } from '../capture/screenshot'
import type { PageMetadata } from '../capture/metadata'
import { newDraft, purgeOldDrafts, putDraft } from '../drafts/db'
import { entries } from './capture-session'
import { productionVerdict } from './rules'

/** Reads the page's metadata in its ISOLATED world (the reader is injected first when capture is not armed). */
export async function pageMetadata(tabId: number): Promise<PageMetadata | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['injected/isolated.js'] })
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => {
        const collect = (window as unknown as { __yodaCollect?: () => Promise<unknown> }).__yodaCollect
        return collect ? await collect() : null
      },
    })
    return (r?.result as PageMetadata | null) ?? null
  } catch {
    return null
  }
}

/**
 * Starts a report from the popup: the screenshot (visible area or full page), the page metadata and the tab's
 * captured logs go into a new draft, and the editor opens on it.
 */
export async function startReport(o: {
  tabId: number
  profileId: string
  kind: 'screenshot' | 'fullPage' | 'textOnly' | 'video' | 'buffer'
  projectId?: string
  attach?: { console: boolean; network: boolean }
  video?: Blob
  /** For the replay buffer: its segments, oldest first. */
  buffer?: Blob[]
  /** For a clip or the buffer: the page it started on (the tab may be closed or its URL unreadable by now). */
  url?: string
  /** For a clip: the tab went to a page not known to be safe while recording. */
  tainted?: boolean
}): Promise<{ draftId: string; truncated?: boolean; fallback?: boolean }> {
  await purgeOldDrafts(Date.now())
  // A clip outlives its tab when the tester closes it: the report is still made, from what is known.
  const tab = await chrome.tabs.get(o.tabId).catch(() => null)
  if (!tab && o.kind !== 'video' && o.kind !== 'buffer') throw new Error('tab_closed')
  const draft = newDraft({ profileId: o.profileId, tabId: o.tabId, tabUrl: tab?.url || o.url || '' })
  // Decided here, from the worker's rules, not by the page that asks: the editor cannot unmark it.
  const verdict = await productionVerdict(draft.tabUrl).catch(() => 'unknown' as const)
  draft.production = verdict === 'production'
  let extra: { truncated?: boolean; fallback?: boolean } = {}
  // The screenshot first: metadata and logs must not change what was on screen.
  if (o.kind === 'screenshot') draft.images.push({ role: 'screenshot', blob: await captureVisible(o.tabId) })
  if (o.kind === 'fullPage') {
    const r = await captureFullPage(o.tabId, () => {})
    draft.images.push({ role: r.fallback ? 'screenshot' : 'screenshot_full', blob: r.blob })
    extra = { truncated: r.truncated, fallback: r.fallback }
  }
  // Video only from a page known not to be production, for the whole clip: otherwise it is discarded here.
  if (o.kind === 'video' && o.video) {
    if (verdict === 'ok' && !o.tainted) draft.video = o.video
    else draft.notice = 'video_dropped'
  }
  // The buffer likewise: kept only when the page is known not to be production now.
  if (o.kind === 'buffer' && o.buffer?.length) {
    if (verdict === 'ok') draft.buffer = o.buffer
    else draft.notice = 'video_dropped'
  }
  if (tab) draft.metadata = (await pageMetadata(o.tabId)) ?? undefined
  const logs = await entries(o.tabId)
  draft.console = logs.console
  draft.network = logs.network
  // The popup's choices become the form's starting point.
  draft.form = {
    ...(o.projectId ? { projectId: o.projectId } : {}),
    attach: { screenshot: true, video: true, buffer: true, console: o.attach?.console ?? !draft.production, network: o.attach?.network ?? !draft.production },
  }
  await putDraft(draft)
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/index.html?draft=${draft.id}`) })
  return { draftId: draft.id, ...extra }
}
