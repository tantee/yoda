import type { ConsoleEntry, NetworkEntry } from '@yoda/shared'
import { CAPTURE_CAPS } from '@yoda/shared'
import { sanitizeEntries } from '../capture/logs'

/**
 * One capture per tab, in storage.session (it survives navigations and service-worker restarts). A same-origin
 * navigation re-injects (activeTab still applies); another origin, a failed injection or a closed tab ends it,
 * and the popup and editor say when and why, so the tester knows the logs stop there.
 */
export type StoppedReason = 'navigated_away' | 'injection_failed' | 'tab_closed'
type Session = {
  state: 'armed' | 'stopped'
  origin: string
  nonce: string | null
  armedAt: number
  stoppedAt?: number
  stoppedReason?: StoppedReason
  console: ConsoleEntry[]
  network: NetworkEntry[]
  dropped: number
}
const key = (tabId: number) => `capture:${tabId}`

async function read(tabId: number): Promise<Session | null> {
  return ((await chrome.storage.session.get(key(tabId)))[key(tabId)] as Session | undefined) ?? null
}
async function write(tabId: number, s: Session): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: s })
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

/** Starts (or restarts) capture on a tab: `inject` puts the scripts in the page and gives the new nonce. */
export async function armTab(tabId: number, url: string, inject: (tabId: number) => Promise<string>): Promise<void> {
  const origin = originOf(url)
  if (!origin) throw new Error('not a web page')
  const prev = await read(tabId)
  const nonce = await inject(tabId)
  await write(tabId, {
    state: 'armed',
    origin,
    nonce,
    armedAt: Date.now(),
    console: prev?.origin === origin ? prev.console : [],
    network: prev?.origin === origin ? prev.network : [],
    dropped: prev?.origin === origin ? prev.dropped : 0,
  })
}

export async function nonceFor(tabId: number): Promise<string | null> {
  const s = await read(tabId)
  return s?.state === 'armed' ? s.nonce : null
}

/** Appends a batch (validated, capped to the newest 500 of each kind). */
export async function appendEntries(tabId: number, raw: unknown[]): Promise<void> {
  const s = await read(tabId)
  if (!s) return
  const clean = sanitizeEntries(raw)
  const keep = <T>(a: T[], b: T[]) => [...a, ...b].slice(-CAPTURE_CAPS.entries)
  await write(tabId, { ...s, console: keep(s.console, clean.console), network: keep(s.network, clean.network), dropped: s.dropped + clean.dropped })
}

export async function entries(tabId: number): Promise<{ console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number }> {
  const s = await read(tabId)
  return { console: s?.console ?? [], network: s?.network ?? [], dropped: s?.dropped ?? 0 }
}

export async function captureState(tabId: number): Promise<{ state: 'off' } | { state: 'armed'; armedAt: number } | { state: 'stopped'; stoppedAt: number; stoppedReason: StoppedReason }> {
  const s = await read(tabId)
  if (!s) return { state: 'off' }
  if (s.state === 'armed') return { state: 'armed', armedAt: s.armedAt }
  return { state: 'stopped', stoppedAt: s.stoppedAt ?? Date.now(), stoppedReason: s.stoppedReason ?? 'navigated_away' }
}

async function stop(tabId: number, reason: StoppedReason): Promise<void> {
  const s = await read(tabId)
  if (s?.state === 'armed') await write(tabId, { ...s, state: 'stopped', nonce: null, stoppedAt: Date.now(), stoppedReason: reason })
}

/** tabs.onUpdated: a finished load in an armed tab re-injects on the same origin and stops otherwise. */
export async function onTabUpdated(
  tabId: number,
  change: { status?: string },
  tab: { url?: string },
  inject: (tabId: number) => Promise<string>,
): Promise<void> {
  if (change.status !== 'complete') return
  const s = await read(tabId)
  if (!s || s.state !== 'armed') return
  if (originOf(tab.url) !== s.origin) return stop(tabId, 'navigated_away')
  try {
    const nonce = await inject(tabId)
    const now = await read(tabId)
    if (now) await write(tabId, { ...now, nonce })
  } catch {
    await stop(tabId, 'injection_failed')
  }
}

/** The tab closed, or its draft was sent: forget its entries. */
export async function onTabRemoved(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId))
}
export const clearTab = onTabRemoved
