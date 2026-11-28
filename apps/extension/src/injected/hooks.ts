/**
 * The MAIN-world capture (no `debugger`): console.*, uncaught errors and rejections, fetch and XHR (method, URL,
 * status, duration and the X-Yoda-Build response header only: never other headers or bodies). Entries go out in
 * batches through `post`. Installing twice on one page returns the first installation. Each hook is installed
 * on its own, so a page that freezes one API still gets the others, and nothing here changes what the page sees.
 */
type Entry = Record<string, unknown>
export type Hooks = { flush: () => void }

const MAX_MESSAGE = 2048
const RING = 500
const KEY = Symbol.for('yoda-reporter/hooks')

/**
 * A short text for a console argument: own data properties only (no getters, no toJSON, so reading it never
 * runs page code), depth 3, stopping at 2048 characters. Cycles show as [Circular].
 */
export function describe(v: unknown, budget = MAX_MESSAGE): string {
  let out = ''
  const seen = new Set<object>()
  const add = (s: string) => {
    if (out.length < budget) out += s.slice(0, budget - out.length)
  }
  const walk = (x: unknown, depth: number) => {
    if (out.length >= budget) return
    if (typeof x === 'string') return add(depth === 0 ? x : JSON.stringify(x.length > budget ? x.slice(0, budget) : x))
    if (x === null || typeof x !== 'object') return add(typeof x === 'function' ? '[Function]' : typeof x === 'symbol' ? x.toString() : String(x))
    if (x instanceof Error) return add(`${x.name}: ${x.message}`)
    if (seen.has(x)) return add('[Circular]')
    if (depth >= 3) return add(Array.isArray(x) ? '[Array]' : '{…}')
    seen.add(x)
    const isArray = Array.isArray(x)
    add(isArray ? '[' : '{')
    let first = true
    let keys: string[]
    try {
      keys = Object.keys(x)
    } catch {
      keys = []
    }
    for (const k of keys) {
      if (out.length >= budget) break
      let d: PropertyDescriptor | undefined
      try {
        d = Object.getOwnPropertyDescriptor(x, k)
      } catch {
        continue
      }
      if (!d || !('value' in d)) continue
      add(first ? '' : ',')
      first = false
      if (!isArray) add(`${JSON.stringify(k)}:`)
      walk(d.value, depth + 1)
    }
    add(isArray ? ']' : '}')
  }
  try {
    walk(v, 0)
  } catch {
    add('[unreadable]')
  }
  return out
}

export function installHooks(w: Window & typeof globalThis, post: (entries: Entry[]) => void, opts: { flushMs?: number } = {}): Hooks {
  const existing = (w as unknown as Record<symbol, Hooks>)[KEY]
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
  let busy = false
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
  const safely = (fn: () => void) => {
    try {
      fn()
    } catch {
      // a page that froze this API keeps the rest of the capture
    }
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    safely(() => {
      const orig = w.console[level]
      w.console[level] = function (this: Console, ...args: unknown[]) {
        // Re-entrant calls (a logged object whose description logs) are passed through, not recorded.
        if (!busy) {
          busy = true
          try {
            push({ kind: 'console', t: now(), level, message: args.map((a) => describe(a)).join(' ').slice(0, MAX_MESSAGE) })
          } catch {
            // never break the page's logging
          } finally {
            busy = false
          }
        }
        return orig.apply(this, args)
      }
    })
  }
  safely(() =>
    w.addEventListener('error', (ev) => {
      try {
        const e = ev as ErrorEvent
        push({ kind: 'console', t: now(), level: 'exception', message: describe(e.error ?? e.message), source: e.filename ? `${e.filename}:${e.lineno}`.slice(0, 500) : undefined })
      } catch {
        // ignore
      }
    }),
  )
  safely(() =>
    w.addEventListener('unhandledrejection', (ev) => {
      try {
        push({ kind: 'console', t: now(), level: 'rejection', message: describe((ev as PromiseRejectionEvent).reason) })
      } catch {
        // ignore
      }
    }),
  )

  safely(() => {
    const origFetch = w.fetch
    if (!origFetch) return
    w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const t0 = now()
      let method = 'GET'
      let url = ''
      try {
        method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        url = absolute(input instanceof Request ? input.url : String(input))
      } catch {
        // describe what we can
      }
      // The page gets a promise that settles exactly as fetch's does; an unhandled rejection stays unhandled.
      return origFetch.call(this, input, init).then(
        (res) => {
          try {
            const build = res.headers.get('x-yoda-build')
            push({ kind: 'network', t: t0, method, url, status: res.status || null, durationMs: now() - t0, failed: res.type !== 'opaque' && !res.ok, type: 'fetch', ...(build ? { yodaBuild: build } : {}) })
          } catch {
            // ignore
          }
          return res
        },
        (err: unknown) => {
          try {
            push({ kind: 'network', t: t0, method, url, status: null, durationMs: now() - t0, failed: !(err instanceof DOMException && err.name === 'AbortError'), type: 'fetch' })
          } catch {
            // ignore
          }
          throw err
        },
      )
    } as typeof fetch
  })

  safely(() => {
    const XHR = w.XMLHttpRequest
    if (!XHR) return
    type Tracked = XMLHttpRequest & { __yoda?: { method: string; url: string; t0: number }; __yodaListening?: boolean }
    const open = XHR.prototype.open
    const send = XHR.prototype.send
    XHR.prototype.open = function (this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
      this.__yoda = { method: String(method).toUpperCase(), url: absolute(String(url)), t0: 0 }
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof XHR.prototype.open
    XHR.prototype.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.__yoda) this.__yoda.t0 = now()
      // One listener per object, reading the current request: a reused XHR logs each request once.
      if (!this.__yodaListening) {
        this.__yodaListening = true
        this.addEventListener('loadend', () => {
          try {
            const meta = this.__yoda
            if (!meta) return
            const status = this.status || null
            const build = status ? this.getResponseHeader('x-yoda-build') : null
            push({ kind: 'network', t: meta.t0, method: meta.method, url: meta.url, status, durationMs: now() - meta.t0, failed: !status || status >= 400, type: 'xhr', ...(build ? { yodaBuild: build } : {}) })
          } catch {
            // ignore
          }
        })
      }
      return send.call(this, body)
    }
  })

  const hooks: Hooks = { flush }
  safely(() => Object.defineProperty(w, KEY, { value: hooks, enumerable: false, configurable: true }))
  safely(() => w.addEventListener('pagehide', flush))
  return hooks
}
