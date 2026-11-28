/** The event the MAIN world dispatches its batches on (a JSON string: objects do not cross worlds). */
export const BRIDGE_EVENT = 'yoda-reporter/v1'
/** At most this many batches a second reach the worker; a page flooding the event is dropped. */
const MAX_PER_SECOND = 10

/**
 * ISOLATED world: forwards the MAIN world's batches to the service worker with this injection's nonce, which
 * lives in this world only. The event is synchronous, so the last batch before a navigation still goes out. A
 * page can forge the event; the worker validates and caps every entry, and this side trims and rate-limits.
 */
export function installBridge(nonce: string): void {
  const w = window as unknown as { __yodaBridgeNonce?: string; __yodaBridgeOn?: boolean }
  w.__yodaBridgeNonce = nonce
  if (w.__yodaBridgeOn) return
  w.__yodaBridgeOn = true
  let window0 = 0
  let sent = 0
  document.addEventListener(BRIDGE_EVENT, (ev) => {
    const detail = (ev as CustomEvent).detail
    if (typeof detail !== 'string' || detail.length > 2_000_000) return
    const now = Date.now()
    if (now - window0 > 1000) {
      window0 = now
      sent = 0
    }
    if (++sent > MAX_PER_SECOND) return
    let entries: unknown
    try {
      entries = JSON.parse(detail)
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    void chrome.runtime.sendMessage({ type: 'capture.collected', nonce: w.__yodaBridgeNonce, entries: entries.slice(-500) }).catch(() => {})
  })
}
