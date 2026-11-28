import type { ConsoleEntry, NetworkEntry } from '@yoda/shared'
import { CAPTURE_CAPS } from '@yoda/shared'
import { sanitizeEntries } from '../capture/logs'

/**
 * One capture per tab. The small state (armed or stopped, origin, nonce) is in storage.session; the entries are
 * in IndexedDB (`yoda-capture`), so noisy pages can never fill the 10 MB session area the tokens live in. Both
 * survive navigations and worker restarts. Every change to a tab's capture runs through that tab's queue, so
 * concurrent batches never lose entries and a late batch never undoes a stop. A same-origin navigation re-injects
 * (activeTab still applies); another origin, a failed injection or a closed tab ends it, and the popup and editor
 * say when and why, so the tester knows the logs stop there.
 */
export type StoppedReason = 'navigated_away' | 'injection_failed' | 'tab_closed'
type State = { state: 'armed' | 'stopped'; origin: string; nonce: string | null; armedAt: number; stoppedAt?: number; stoppedReason?: StoppedReason }
type Logs = { tabId: number; origin: string; console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number }
const key = (tabId: number) => `capture:${tabId}`

// --- the per-tab queue ---
const queues = new Map<number, Promise<unknown>>()
function serial<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(tabId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  queues.set(tabId, tail)
  void tail.then(() => {
    if (queues.get(tabId) === tail) queues.delete(tabId)
  })
  return next
}

// --- state in storage.session ---
async function readState(tabId: number): Promise<State | null> {
  return ((await chrome.storage.session.get(key(tabId)))[key(tabId)] as State | undefined) ?? null
}
const writeState = (tabId: number, s: State) => chrome.storage.session.set({ [key(tabId)]: s })

// --- entries in IndexedDB ---
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('yoda-capture', 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('logs')) req.result.createObjectStore('logs', { keyPath: 'tabId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction('logs', mode)
      const r = fn(t.objectStore('logs'))
      t.oncomplete = () => resolve(r ? r.result : undefined)
      t.onerror = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}
const readLogs = async (tabId: number) => ((await idb<Logs>('readonly', (s) => s.get(tabId))) as Logs | undefined) ?? null
const writeLogs = (l: Logs) => idb('readwrite', (s) => s.put(l))
const deleteLogs = (tabId: number) => idb('readwrite', (s) => s.delete(tabId))

const originOf = (url: string | undefined) => {
  try {
    const u = url ? new URL(url) : null
    return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null
  } catch {
    return null
  }
}

/**
 * Starts (or restarts) capture on a tab. The nonce is stored before the scripts go in, so the first batch of the
 * new injection is already accepted; `inject` puts the scripts in the page with that nonce.
 */
export function armTab(tabId: number, url: string, inject: (tabId: number, nonce: string) => Promise<void>): Promise<void> {
  return serial(tabId, async () => {
    const origin = originOf(url)
    if (!origin) throw new Error('not a web page')
    const nonce = crypto.randomUUID()
    await writeState(tabId, { state: 'armed', origin, nonce, armedAt: Date.now() })
    const logs = await readLogs(tabId)
    if (!logs || logs.origin !== origin) await writeLogs({ tabId, origin, console: [], network: [], dropped: 0 })
    try {
      await inject(tabId, nonce)
    } catch (err) {
      await chrome.storage.session.remove(key(tabId))
      throw err
    }
  })
}

export async function nonceFor(tabId: number): Promise<string | null> {
  const s = await readState(tabId)
  return s?.state === 'armed' ? s.nonce : null
}

/** Appends a batch (validated, the newest 500 of each kind kept) while the tab is armed. */
export function appendEntries(tabId: number, raw: unknown[]): Promise<void> {
  return serial(tabId, async () => {
    const s = await readState(tabId)
    if (!s || s.state !== 'armed') return
    const clean = sanitizeEntries(raw)
    const l = (await readLogs(tabId)) ?? { tabId, origin: s.origin, console: [], network: [], dropped: 0 }
    const keep = <T>(a: T[], b: T[]) => [...a, ...b].slice(-CAPTURE_CAPS.entries)
    await writeLogs({ ...l, console: keep(l.console, clean.console), network: keep(l.network, clean.network), dropped: l.dropped + clean.dropped })
  })
}

export async function entries(tabId: number): Promise<{ console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number }> {
  const l = await readLogs(tabId)
  return { console: l?.console ?? [], network: l?.network ?? [], dropped: l?.dropped ?? 0 }
}

export async function captureState(tabId: number): Promise<{ state: 'off' } | { state: 'armed'; armedAt: number } | { state: 'stopped'; stoppedAt: number; stoppedReason: StoppedReason }> {
  const s = await readState(tabId)
  if (!s) return { state: 'off' }
  if (s.state === 'armed') return { state: 'armed', armedAt: s.armedAt }
  return { state: 'stopped', stoppedAt: s.stoppedAt ?? Date.now(), stoppedReason: s.stoppedReason ?? 'navigated_away' }
}

async function stop(tabId: number, reason: StoppedReason): Promise<void> {
  const s = await readState(tabId)
  if (s?.state === 'armed') await writeState(tabId, { ...s, state: 'stopped', nonce: null, stoppedAt: Date.now(), stoppedReason: reason })
}

/**
 * tabs.onUpdated for an armed tab: as soon as a new document starts loading (a URL is known), re-inject on the
 * same origin, so its load is captured too, or stop on another origin. A failed early injection is retried
 * once the document has loaded. Libraries that kept their own copy of fetch before our hooks went in stay
 * unseen; XHR is always seen.
 */
export function onTabUpdated(tabId: number, change: { status?: string; url?: string }, tab: { url?: string }, inject: (tabId: number, nonce: string) => Promise<void>): Promise<void> {
  return serial(tabId, async () => {
    if (change.status !== 'loading' && change.status !== 'complete') return
    const s = await readState(tabId)
    if (!s || s.state !== 'armed') return
    const url = change.url ?? tab.url
    if (!url) return
    if (originOf(url) !== s.origin) return stop(tabId, 'navigated_away')
    const nonce = crypto.randomUUID()
    await writeState(tabId, { ...s, nonce })
    try {
      await inject(tabId, nonce)
    } catch {
      if (change.status === 'complete') await stop(tabId, 'injection_failed')
    }
  })
}

/** The tab closed, or its draft was sent: forget its capture. */
export function onTabRemoved(tabId: number): Promise<void> {
  return serial(tabId, async () => {
    await chrome.storage.session.remove(key(tabId))
    await deleteLogs(tabId)
  })
}
export const clearTab = onTabRemoved
