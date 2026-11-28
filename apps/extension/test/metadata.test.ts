// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { collectMetadata } from '../src/capture/metadata'

describe('collectMetadata', () => {
  it('reads the page, the build sources and the client, with a 1 s well-known timeout', async () => {
    document.head.innerHTML = '<title>OPD</title><meta name="yoda-build" content="repo=demo/app;commit=abc1234;env=uat"><meta name="yoda-route" content="opd-queue">'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ commit: 'zzz' }), { status: 200, headers: { 'x-yoda-build': 'commit=hhh' } }))
    const m = await collectMetadata()
    expect(m.page.title).toBe('OPD')
    expect(m.page.route).toContain('opd-queue')
    expect(m.buildSources.meta).toBe('repo=demo/app;commit=abc1234;env=uat')
    expect(m.buildSources.wellKnown).toEqual({ commit: 'zzz' })
    expect(m.buildSources.headers).toEqual(['commit=hhh'])
    expect(m.client.viewport.w).toBeGreaterThan(0)
    expect(typeof m.client.timeZone).toBe('string')
    expect((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![0]).toMatch(/\/\.well-known\/yoda-build\.json$/)
  })

  it('names the real browser, never a GREASE brand', async () => {
    document.head.innerHTML = '<title>x</title>'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('none'))
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { brands: [], platform: 'macOS', getHighEntropyValues: async () => ({ fullVersionList: [{ brand: 'Not.A/Brand', version: '24.0.0.0' }, { brand: 'Chromium', version: '158.0.8127.18' }], platformVersion: '26.6.2', platform: 'macOS' }) },
    })
    const m = await collectMetadata()
    expect([m.client.browser, m.client.browserVersion, m.client.os]).toEqual(['Chromium', '158.0.8127.18', 'macOS'])
  })

  it('a slow or missing well-known file is skipped', async () => {
    document.head.innerHTML = '<title>x</title>'
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_r, reject) => (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')))))
    const t0 = Date.now()
    const m = await collectMetadata({ wellKnownTimeoutMs: 50 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(m.buildSources.wellKnown).toBeNull()
    expect(m.buildSources.meta).toBeNull()
  })
})
