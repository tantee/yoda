import { CAPTURE_CAPS, ConsoleEntry, NetworkEntry, type DefectBackendBuild } from '@yoda/shared'
import { parseYodaBuild } from './build'

/**
 * Page data is untrusted (Review Focus 4): every entry from the MAIN world, or from a page forging our
 * postMessage, is validated with the shared schemas, messages are cut to 2048 characters, and only the newest
 * 500 of each kind are kept. The wire form tags each entry `kind: 'console' | 'network'`; a network entry's own
 * fetch/xhr/resource kind travels as `type`.
 */
export function sanitizeEntries(raw: unknown[]): { console: ConsoleEntry[]; network: NetworkEntry[]; dropped: number } {
  const consoleOut: ConsoleEntry[] = []
  const networkOut: NetworkEntry[] = []
  let dropped = 0
  for (const r of raw) {
    if (!r || typeof r !== 'object') {
      dropped++
      continue
    }
    const o = r as Record<string, unknown>
    if (o.kind === 'console') {
      const parsed = ConsoleEntry.safeParse({ ...o, message: typeof o.message === 'string' ? o.message.slice(0, CAPTURE_CAPS.message) : o.message, source: typeof o.source === 'string' ? o.source.slice(0, 500) : undefined })
      if (parsed.success) consoleOut.push(parsed.data)
      else dropped++
    } else if (o.kind === 'network') {
      const parsed = NetworkEntry.safeParse({
        t: o.t,
        method: typeof o.method === 'string' ? o.method.slice(0, 20) : o.method,
        url: typeof o.url === 'string' ? o.url.slice(0, 2048) : o.url,
        status: o.status,
        durationMs: o.durationMs,
        failed: o.failed,
        kind: o.type,
        yodaBuild: typeof o.yodaBuild === 'string' ? o.yodaBuild.slice(0, 500) : undefined,
      })
      if (parsed.success) networkOut.push(parsed.data)
      else dropped++
    } else dropped++
  }
  const cut = <T>(list: T[]) => {
    const extra = Math.max(0, list.length - CAPTURE_CAPS.entries)
    dropped += extra
    return list.slice(extra)
  }
  return { console: cut(consoleOut), network: cut(networkOut), dropped }
}

/**
 * Failed loads the fetch/XHR hooks cannot see (scripts, images, stylesheets): an HTTP error status, or a
 * same-origin load with no status and nothing transferred (blocked or refused).
 */
export function resourceFailures(entries: (PerformanceResourceTiming & { responseStatus?: number })[], origin: string): NetworkEntry[] {
  const out: NetworkEntry[] = []
  for (const e of entries) {
    if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') continue
    const status = e.responseStatus ?? 0
    let sameOrigin = false
    try {
      sameOrigin = new URL(e.name).origin === origin
    } catch {
      continue
    }
    const blocked = status === 0 && e.transferSize === 0 && sameOrigin
    if (status < 400 && !blocked) continue
    out.push({ t: Math.round(e.startTime), method: 'GET', url: e.name.slice(0, 2048), status: status || null, durationMs: Math.round(e.duration), failed: true, kind: 'resource' })
  }
  return out
}

/** The back-end builds the page talked to (X-Yoda-Build on their responses): one per origin, the latest, at most 10. */
export function backendBuilds(network: NetworkEntry[]): DefectBackendBuild[] {
  const byOrigin = new Map<string, DefectBackendBuild>()
  for (const n of network) {
    if (!n.yodaBuild) continue
    let origin: string
    try {
      origin = new URL(n.url).origin
    } catch {
      continue
    }
    const f = parseYodaBuild(n.yodaBuild)
    if (!f.repo && !f.branch && !f.commit) continue
    byOrigin.delete(origin)
    byOrigin.set(origin, { origin, ...(f.repo ? { repo: f.repo } : {}), ...(f.branch ? { branch: f.branch } : {}), ...(f.commit ? { commit: f.commit } : {}) })
  }
  return [...byOrigin.values()].slice(0, CAPTURE_CAPS.backendBuilds)
}
