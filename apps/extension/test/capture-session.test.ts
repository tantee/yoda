import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome } from './support/chrome'

beforeEach(async () => {
  installChrome()
  vi.resetModules()
  await new Promise<void>((r) => {
    const q = indexedDB.deleteDatabase('yoda-capture')
    q.onsuccess = q.onerror = () => r()
  })
})
const ok = async () => {}

const load = () => import('../src/sw/capture-session')
const e = (i: number) => ({ kind: 'console', t: i, level: 'error', message: `m${i}` })

describe('capture sessions', () => {
  it('entries survive a same-origin navigation and the capture is re-injected', async () => {
    const s = await load()
    const inject = vi.fn(async (_tabId: number, _nonce: string) => {})
    await s.armTab(7, 'https://app.example.org/opd', ok)
    const first = await s.nonceFor(7)
    await s.appendEntries(7, [e(1), e(2)])
    // As soon as the new document starts loading, so its load is captured too.
    await s.onTabUpdated(7, { status: 'loading', url: 'https://app.example.org/ward' }, {}, inject)
    expect(inject).toHaveBeenCalledWith(7, expect.any(String))
    expect(await s.captureState(7)).toMatchObject({ state: 'armed' })
    expect(await s.nonceFor(7)).toBe(inject.mock.calls[0]![1])
    expect(await s.nonceFor(7)).not.toBe(first)
    await s.appendEntries(7, [e(3)])
    expect((await s.entries(7)).console.map((x) => x.t)).toEqual([1, 2, 3])
  })

  it('a cross-origin navigation stops capture with navigated_away and keeps the earlier entries', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/opd', ok)
    await s.appendEntries(7, [e(1)])
    const inject = vi.fn(async () => {})
    await s.onTabUpdated(7, { status: 'complete' }, { url: 'https://other.example.org/' }, inject)
    expect(inject).not.toHaveBeenCalled()
    expect(await s.captureState(7)).toMatchObject({ state: 'stopped', stoppedReason: 'navigated_away' })
    expect((await s.entries(7)).console).toHaveLength(1)
    expect(await s.nonceFor(7)).toBeNull()
  })

  it('a failed re-injection stops capture with injection_failed', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/opd', ok)
    await s.onTabUpdated(7, { status: 'complete' }, { url: 'https://app.example.org/x' }, async () => {
      throw new Error('Cannot access contents of the page')
    })
    expect(await s.captureState(7)).toMatchObject({ state: 'stopped', stoppedReason: 'injection_failed' })
  })

  it('entries persist in storage.session across a service-worker restart', async () => {
    let s = await load()
    await s.armTab(7, 'https://app.example.org/', ok)
    await s.appendEntries(7, [e(1)])
    vi.resetModules()
    s = await load()
    expect((await s.entries(7)).console).toHaveLength(1)
    expect(await s.captureState(7)).toMatchObject({ state: 'armed' })
  })

  it('keeps the newest 500 of each kind per tab, and clears on close', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/', ok)
    for (let i = 0; i < 6; i++) await s.appendEntries(7, Array.from({ length: 100 }, (_, j) => e(i * 100 + j)))
    const got = await s.entries(7)
    expect(got.console).toHaveLength(500)
    expect(got.console[0]!.t).toBe(100)
    await s.onTabRemoved(7)
    expect(await s.captureState(7)).toEqual({ state: 'off' })
    expect((await s.entries(7)).console).toEqual([])
  })

  it('concurrent batches never lose entries, and a late batch never undoes a stop', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/', ok)
    await Promise.all([s.appendEntries(7, [e(1)]), s.appendEntries(7, [e(2)]), s.appendEntries(7, [e(3)])])
    expect((await s.entries(7)).console.map((x) => x.t).sort()).toEqual([1, 2, 3])
    await Promise.all([s.onTabUpdated(7, { status: 'loading', url: 'https://other.example.org/' }, {}, ok), s.appendEntries(7, [e(4)])])
    expect(await s.captureState(7)).toMatchObject({ state: 'stopped', stoppedReason: 'navigated_away' })
  })

  it('logs never go to storage.session (only the small state does)', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/', ok)
    await s.appendEntries(7, [e(1)])
    const session = JSON.stringify([...(chrome.storage.session as unknown as { data: Map<string, unknown> }).data])
    expect(session).not.toContain('m1')
  })

  it('only http(s) pages can be armed', async () => {
    const s = await load()
    await expect(s.armTab(7, 'file:///etc/hosts', ok)).rejects.toThrow()
    await expect(s.armTab(7, 'chrome://settings', ok)).rejects.toThrow()
  })
})
