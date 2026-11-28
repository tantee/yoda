import { captureFullPage, captureVisible } from '../capture/screenshot'
import type { PageMetadata } from '../capture/metadata'
import { newDraft, purgeOldDrafts, putDraft } from '../drafts/db'
import { entries } from './capture-session'

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
export async function startReport(o: { tabId: number; profileId: string; kind: 'screenshot' | 'fullPage' | 'textOnly'; projectId?: string; attach?: { console: boolean; network: boolean } }): Promise<{ draftId: string; truncated?: boolean; fallback?: boolean }> {
  await purgeOldDrafts(Date.now())
  const tab = await chrome.tabs.get(o.tabId)
  const draft = newDraft({ profileId: o.profileId, tabId: o.tabId, tabUrl: tab.url ?? '' })
  let extra: { truncated?: boolean; fallback?: boolean } = {}
  // The screenshot first: metadata and logs must not change what was on screen.
  if (o.kind === 'screenshot') draft.images.push({ role: 'screenshot', blob: await captureVisible(o.tabId) })
  if (o.kind === 'fullPage') {
    const r = await captureFullPage(o.tabId, () => {})
    draft.images.push({ role: r.fallback ? 'screenshot' : 'screenshot_full', blob: r.blob })
    extra = { truncated: r.truncated, fallback: r.fallback }
  }
  draft.metadata = (await pageMetadata(o.tabId)) ?? undefined
  const logs = await entries(o.tabId)
  draft.console = logs.console
  draft.network = logs.network
  // The popup's choices become the form's starting point.
  draft.form = {
    ...(o.projectId ? { projectId: o.projectId } : {}),
    attach: { screenshot: true, video: true, buffer: true, console: o.attach?.console ?? true, network: o.attach?.network ?? true },
  }
  await putDraft(draft)
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/index.html?draft=${draft.id}`) })
  return { draftId: draft.id, ...extra }
}
