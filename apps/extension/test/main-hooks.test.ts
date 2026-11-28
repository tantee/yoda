// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { describe as describeArg, installHooks } from '../src/injected/hooks'

const fresh = () => delete (window as unknown as Record<symbol, unknown>)[Symbol.for('yoda-reporter/hooks')]

describe('the MAIN-world hooks', () => {
  it('wrap fetch without changing its result or rejection, and record method, URL, status and X-Yoda-Build only', async () => {
    const posted: unknown[] = []
    const realFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('fail') ? Promise.reject(new TypeError('network')) : new Response('body', { status: 500, headers: { 'x-yoda-build': 'commit=abc', 'set-cookie': 'secret=1' } }),
    )
    window.fetch = realFetch as unknown as typeof fetch
    fresh()
    const h = installHooks(window, (entries) => posted.push(...entries), { flushMs: 0 })
    const res = await window.fetch('https://api.example.org/x', { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'secret-body' })
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('body')
    await expect(window.fetch('https://api.example.org/fail')).rejects.toThrow('network')
    h.flush()
    const text = JSON.stringify(posted)
    expect(text).not.toContain('secret-body')
    expect(text).not.toContain('Bearer t')
    expect(text).not.toContain('secret=1')
    expect(posted).toEqual([
      expect.objectContaining({ kind: 'network', method: 'POST', url: 'https://api.example.org/x', status: 500, failed: true, type: 'fetch', yodaBuild: 'commit=abc' }),
      expect.objectContaining({ kind: 'network', method: 'GET', url: 'https://api.example.org/fail', status: null, failed: true, type: 'fetch' }),
    ])
  })

  it('wraps console.* and is idempotent per page', () => {
    // A fresh page: the first test installed on this window already.
    fresh()
    const posted: { kind: string; level?: string; message?: string }[] = []
    const h1 = installHooks(window, (e) => posted.push(...(e as typeof posted)), { flushMs: 0 })
    const h2 = installHooks(window, (e) => posted.push(...(e as typeof posted)), { flushMs: 0 })
    expect(h2).toBe(h1)
    console.error('boom', { a: 1 })
    console.warn('careful')
    h1.flush()
    expect(posted.filter((p) => p.kind === 'console').map((p) => [p.level, p.message])).toEqual([
      ['error', 'boom {"a":1}'],
      ['warn', 'careful'],
    ])
  })
})

describe('describe (console arguments)', () => {
  it('reads own data properties only: no getters, no toJSON, cycles marked, cut at 2048', () => {
    let ran = 0
    const o: Record<string, unknown> = { a: 1, toJSON: () => (ran++, 'x') }
    Object.defineProperty(o, 'g', { get: () => (ran++, 2), enumerable: true })
    o.self = o
    expect(describeArg(o)).toBe('{"a":1,"toJSON":[Function],"self":[Circular]}')
    expect(ran).toBe(0)
    expect(describeArg('x'.repeat(1_000_000))).toHaveLength(2048)
    expect(describeArg({ big: Array.from({ length: 100_000 }, (_, i) => i) }).length).toBeLessThanOrEqual(2048)
    expect(describeArg(new Error('boom'))).toBe('Error: boom')
  })
})

describe('fetch and XHR semantics', () => {
  it("a page's unhandled fetch rejection stays unhandled", async () => {
    fresh()
    window.fetch = (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    installHooks(window, () => {}, { flushMs: 0 })
    const unhandled: unknown[] = []
    const onUnhandled = (r: unknown) => unhandled.push(r)
    process.on('unhandledRejection', onUnhandled)
    void window.fetch('https://api.example.org/x')
    await new Promise((r) => setTimeout(r, 20))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toHaveLength(1)
  })

  it('a reused XHR logs each request once', async () => {
    fresh()
    const posted: { url?: string }[] = []
    const h = installHooks(window, (e) => posted.push(...(e as typeof posted)), { flushMs: 0 })
    const x = new XMLHttpRequest()
    for (const p of ['a', 'b']) {
      x.open('GET', `https://api.example.org/${p}`)
      x.send()
      x.dispatchEvent(new Event('loadend'))
    }
    h.flush()
    expect(posted.filter((p) => p.url?.startsWith('https://api.example.org/')).map((p) => p.url)).toEqual(['https://api.example.org/a', 'https://api.example.org/b'])
  })
})
