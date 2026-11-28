import { planStitch } from './stitch'

/** captureVisibleTab allows 2 calls a second (Chrome's quota). */
const FRAME_GAP_MS = 550

const toBlob = async (dataUrl: string) => (await fetch(dataUrl)).blob()

/** The visible area of the tab (activeTab), as PNG. */
export async function captureVisible(tabId: number): Promise<Blob> {
  const tab = await chrome.tabs.get(tabId)
  return toBlob(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
}

type PageInfo = { scrollHeight: number; viewportHeight: number; viewportWidth: number; dpr: number; scrollY: number; scroller: 'document' | 'element' }

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
  try {
    const frames: ImageBitmap[] = []
    for (let i = 0; i < plan.offsets.length; i++) {
      await run(scrollTo, plan.offsets[i]!, i > 0)
      await new Promise((r) => setTimeout(r, i === 0 ? 150 : FRAME_GAP_MS))
      frames.push(await createImageBitmap(await captureVisible(tabId)))
      onProgress(i + 1, plan.offsets.length)
    }
    const scale = frames[0]!.width / info.viewportWidth
    const canvas = new OffscreenCanvas(frames[0]!.width, Math.round(plan.height * scale))
    const ctx = canvas.getContext('2d')!
    plan.offsets.forEach((y, i) => ctx.drawImage(frames[i]!, 0, Math.round(y * scale)))
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), truncated: plan.truncated, fallback: false }
  } catch {
    return { blob: await captureVisible(tabId), truncated: false, fallback: true }
  } finally {
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
  return {
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
  if (st.el) st.el.scrollTop = y
  else window.scrollTo(0, y)
}

function restoreScroll(): void {
  const w = window as unknown as { __yodaScroll?: { el: Element | null; y: number; hidden: [HTMLElement, string][] } }
  const st = w.__yodaScroll
  if (!st) return
  for (const [e, v] of st.hidden) e.style.visibility = v
  if (st.el) st.el.scrollTop = st.y
  else window.scrollTo(0, st.y)
  delete w.__yodaScroll
}
