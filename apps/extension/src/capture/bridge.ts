/**
 * ISOLATED world: forwards the MAIN world's batches to the service worker, tagged with this injection's nonce
 * (set by the worker in this isolated world only; the page never sees it). Only same-window messages of our type
 * pass. A page can still forge one; the worker validates and caps every entry.
 */
export function installBridge(nonce: string): void {
  const w = window as unknown as { __yodaBridge?: string }
  if (w.__yodaBridge === nonce) return
  w.__yodaBridge = nonce
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || w.__yodaBridge !== nonce) return
    const d = ev.data as { type?: unknown; entries?: unknown }
    if (!d || d.type !== 'yoda-reporter/v1' || !Array.isArray(d.entries)) return
    void chrome.runtime.sendMessage({ type: 'capture.collected', nonce, entries: d.entries.slice(0, 1000) }).catch(() => {})
  })
}
