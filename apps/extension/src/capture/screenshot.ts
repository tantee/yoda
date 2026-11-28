import { framePlacements, planStitch, type Rect } from './stitch'

/** captureVisibleTab allows 2 calls a second (Chrome's quota). */
const FRAME_GAP_MS = 550

const toBlob = async (dataUrl: string) => (await fetch(dataUrl)).blob()

/** The visible area of the tab (activeTab), as PNG. */
export async function captureVisible(tabId: number): Promise<Blob> {
  const tab = await chrome.tabs.get(tabId)
  return toBlob(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
}

type PageInfo = { scrollHeight: number; viewportHeight: number; viewportWidth: number; dpr: number; scrollY: number; scroller: 'document' | 'element'; view: Rect }

/** The tester switched tabs or the page navigated mid-capture: stop rather than stitch another page in. */
export class TabChangedError extends Error {
  constructor() {
    super('tab_changed')
  }
}

/**
 * Full page (beta): finds the scroller (the document, or the tallest scrolling element filling the viewport),
 * scrolls frame by frame at most twice a second, hides fixed and sticky elements after the first frame, stitches
 * on an OffscreenCanvas, and always restores scroll and styles. Falls back to the visible area (`fallback: true`).
 */
export async function captureFullPage(tabId: number, onProgress: (done: number, total: number) => void): Promise<{ blob: Blob; truncated: boolean; fallback: boolean }> {
  const run = async <A extends unknown[], R>(func: (...a: A) => R, ...args: A): Promise<R> => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func, args })
    return r!.result as R
  }
  let info: PageInfo
  try {
    info = await run(prepareScroll)
  } catch {
    return { blob: await captureVisible(tabId), truncated: false, fallback: true }
  }
  const plan = planStitch({ scrollHeight: info.scrollHeight, viewportHeight: info.viewportHeight, dpr: info.dpr })
  const start = await chrome.tabs.get(tabId)
  const frames: ImageBitmap[] = []
  try {
    for (let i = 0; i < plan.offsets.length; i++) {
      await run(scrollTo, plan.offsets[i]!, i > 0)
      await new Promise((r) => setTimeout(r, i === 0 ? 150 : FRAME_GAP_MS))
      // captureVisibleTab takes whatever tab is in front now: only ever the one being reported.
      const now = await chrome.tabs.get(tabId)
      if (!now.active || now.windowId !== start.windowId || now.url !== start.url) throw new TabChangedError()
      frames.push(await createImageBitmap(await captureVisible(tabId)))
      onProgress(i + 1, plan.offsets.length)
    }
    const { canvas: size, draws } = framePlacements(plan.offsets, info.view, frames[0]!.width / info.viewportWidth)
    const canvas = new OffscreenCanvas(size.width, size.height)
    const ctx = canvas.getContext('2d')!
    draws.forEach((d, i) => ctx.drawImage(frames[i]!, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.sw, d.sh))
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), truncated: plan.truncated, fallback: false }
  } catch (e) {
    if (e instanceof TabChangedError) throw e
    return { blob: await captureVisible(tabId), truncated: false, fallback: true }
  } finally {
    for (const f of frames) f.close()
    await run(restoreScroll).catch(() => {})
  }
}

// --- Run in the page (ISOLATED world): self-contained functions, no closures. ---

function prepareScroll(): PageInfo {
  const w = window as unknown as { __yodaScroll?: { el: Element | null; y: number; hidden: [HTMLElement, string][] } }
  const vh = window.innerHeight
  let el: Element | null = null
  if (document.documentElement.scrollHeight <= vh + 2) {
    for (const c of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const s = getComputedStyle(c)
      if (!/(auto|scroll)/.test(s.overflowY) || c.scrollHeight <= c.clientHeight + 2) continue
      if (c.clientHeight >= vh * 0.6 && (!el || c.scrollHeight > el.scrollHeight)) el = c
    }
  }
  w.__yodaScroll = { el, y: el ? el.scrollTop : window.scrollY, hidden: [] }
  // The part of the tab that scrolls: the element's client box (no borders or scroll bar), or the viewport.
  let view = { left: 0, top: 0, width: window.innerWidth, height: vh }
  if (el) {
    const r = el.getBoundingClientRect()
    view = { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight }
  }
  return {
    view,
    scrollHeight: el ? el.scrollHeight : document.documentElement.scrollHeight,
    viewportHeight: el ? el.clientHeight : vh,
    viewportWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    scrollY: w.__yodaScroll.y,
    scroller: el ? 'element' : 'document',
  }
}

function scrollTo(y: number, hideFixed: boolean): void {
  const st = (window as unknown as { __yodaScroll?: { el: Element | null; hidden: [HTMLElement, string][] } }).__yodaScroll
  if (!st) return
  if (hideFixed && !st.hidden.length) {
    for (const e of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const p = getComputedStyle(e).position
      if (p === 'fixed' || p === 'sticky') {
        st.hidden.push([e, e.style.visibility])
        e.style.visibility = 'hidden'
      }
    }
  }
  // Instant even under `scroll-behavior: smooth`, so the frame is not taken mid-scroll.
  if (st.el) st.el.scrollTo({ top: y, behavior: 'instant' })
  else window.scrollTo({ top: y, behavior: 'instant' })
}

function restoreScroll(): void {
  const w = window as unknown as { __yodaScroll?: { el: Element | null; y: number; hidden: [HTMLElement, string][] } }
  const st = w.__yodaScroll
  if (!st) return
  for (const [e, v] of st.hidden) e.style.visibility = v
  if (st.el) st.el.scrollTo({ top: st.y, behavior: 'instant' })
  else window.scrollTo({ top: st.y, behavior: 'instant' })
  delete w.__yodaScroll
}
