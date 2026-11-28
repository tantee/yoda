// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { installHooks } from '../src/injected/hooks'

describe('the MAIN-world hooks', () => {
  it('wrap fetch without changing its result or rejection, and record method, URL, status and X-Yoda-Build only', async () => {
    const posted: unknown[] = []
    const realFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('fail') ? Promise.reject(new TypeError('network')) : new Response('body', { status: 500, headers: { 'x-yoda-build': 'commit=abc', 'set-cookie': 'secret=1' } }),
    )
    window.fetch = realFetch as unknown as typeof fetch
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
    delete (window as unknown as Record<string, unknown>).__yodaReporterHooks
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
