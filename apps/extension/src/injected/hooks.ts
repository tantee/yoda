/**
 * The MAIN-world capture (no `debugger`): console.*, uncaught errors and rejections, fetch and XHR (method, URL,
 * status, duration and the X-Yoda-Build response header only: never other headers or bodies). Entries go out in
 * batches through `post`. Installing twice on one page returns the first installation.
 */
type Entry = Record<string, unknown>
export type Hooks = { flush: () => void }

const MAX_MESSAGE = 2048
const RING = 500
const KEY = '__yodaReporterHooks'

function text(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export function installHooks(w: Window & typeof globalThis, post: (entries: Entry[]) => void, opts: { flushMs?: number } = {}): Hooks {
  const existing = (w as unknown as Record<string, Hooks>)[KEY]
  if (existing) return existing
  const queue: Entry[] = []
  const now = () => Math.round(w.performance?.now?.() ?? Date.now())
  const absolute = (u: string) => {
    try {
      return new URL(u, w.location.href).href
    } catch {
      return u
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (queue.length) post(queue.splice(0))
  }
  const push = (e: Entry) => {
    queue.push(e)
    if (queue.length > RING) queue.splice(0, queue.length - RING)
    if (!timer && opts.flushMs !== 0) timer = setTimeout(flush, opts.flushMs ?? 500)
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = w.console[level]
    w.console[level] = function (this: Console, ...args: unknown[]) {
      try {
        push({ kind: 'console', t: now(), level, message: args.map(text).join(' ').slice(0, MAX_MESSAGE) })
      } catch {
        // never break the page's logging
      }
      return orig.apply(this, args)
    }
  }
  w.addEventListener('error', (ev) => {
    const e = ev as ErrorEvent
    push({ kind: 'console', t: now(), level: 'exception', message: text(e.error ?? e.message).slice(0, MAX_MESSAGE), source: e.filename ? `${e.filename}:${e.lineno}` : undefined })
  })
  w.addEventListener('unhandledrejection', (ev) => {
    push({ kind: 'console', t: now(), level: 'rejection', message: text((ev as PromiseRejectionEvent).reason).slice(0, MAX_MESSAGE) })
  })

  const origFetch = w.fetch
  if (origFetch) {
    w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const t0 = now()
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const url = absolute(input instanceof Request ? input.url : String(input))
      const result = origFetch.call(this, input, init)
      result.then(
        (res) => push({ kind: 'network', t: t0, method, url, status: res.status, durationMs: now() - t0, failed: !res.ok, type: 'fetch', ...(res.headers.get('x-yoda-build') ? { yodaBuild: res.headers.get('x-yoda-build') } : {}) }),
        () => push({ kind: 'network', t: t0, method, url, status: null, durationMs: now() - t0, failed: true, type: 'fetch' }),
      )
      // The page gets exactly what fetch gave: the same promise, result or rejection.
      return result
    } as typeof fetch
  }

  const XHR = w.XMLHttpRequest
  if (XHR) {
    const open = XHR.prototype.open
    const send = XHR.prototype.send
    XHR.prototype.open = function (this: XMLHttpRequest & { __yoda?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__yoda = { method: String(method).toUpperCase(), url: absolute(String(url)) }
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof XHR.prototype.open
    XHR.prototype.send = function (this: XMLHttpRequest & { __yoda?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const t0 = now()
      const meta = this.__yoda
      this.addEventListener('loadend', () => {
        if (!meta) return
        const status = this.status || null
        const build = status ? this.getResponseHeader('x-yoda-build') : null
        push({ kind: 'network', t: t0, method: meta.method, url: meta.url, status, durationMs: now() - t0, failed: !status || status >= 400, type: 'xhr', ...(build ? { yodaBuild: build } : {}) })
      })
      return send.call(this, body)
    }
  }

  const hooks: Hooks = { flush }
  ;(w as unknown as Record<string, Hooks>)[KEY] = hooks
  w.addEventListener('pagehide', flush)
  return hooks
}
