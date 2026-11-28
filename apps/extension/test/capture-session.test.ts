import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome } from './support/chrome'

beforeEach(() => {
  installChrome()
  vi.resetModules()
})

const load = () => import('../src/sw/capture-session')
const e = (i: number) => ({ kind: 'console', t: i, level: 'error', message: `m${i}` })

describe('capture sessions', () => {
  it('entries survive a same-origin navigation and the capture is re-injected', async () => {
    const s = await load()
    const inject = vi.fn(async () => 'n2')
    await s.armTab(7, 'https://app.example.org/opd', async () => 'n1')
    await s.appendEntries(7, [e(1), e(2)])
    await s.onTabUpdated(7, { status: 'complete' }, { url: 'https://app.example.org/ward' }, inject)
    expect(inject).toHaveBeenCalledWith(7)
    expect(await s.captureState(7)).toMatchObject({ state: 'armed' })
    expect(await s.nonceFor(7)).toBe('n2')
    await s.appendEntries(7, [e(3)])
    expect((await s.entries(7)).console.map((x) => x.t)).toEqual([1, 2, 3])
  })

  it('a cross-origin navigation stops capture with navigated_away and keeps the earlier entries', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/opd', async () => 'n1')
    await s.appendEntries(7, [e(1)])
    const inject = vi.fn(async () => 'x')
    await s.onTabUpdated(7, { status: 'complete' }, { url: 'https://other.example.org/' }, inject)
    expect(inject).not.toHaveBeenCalled()
    expect(await s.captureState(7)).toMatchObject({ state: 'stopped', stoppedReason: 'navigated_away' })
    expect((await s.entries(7)).console).toHaveLength(1)
    expect(await s.nonceFor(7)).toBeNull()
  })

  it('a failed re-injection stops capture with injection_failed', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/opd', async () => 'n1')
    await s.onTabUpdated(7, { status: 'complete' }, { url: 'https://app.example.org/x' }, async () => {
      throw new Error('Cannot access contents of the page')
    })
    expect(await s.captureState(7)).toMatchObject({ state: 'stopped', stoppedReason: 'injection_failed' })
  })

  it('entries persist in storage.session across a service-worker restart', async () => {
    let s = await load()
    await s.armTab(7, 'https://app.example.org/', async () => 'n1')
    await s.appendEntries(7, [e(1)])
    vi.resetModules()
    s = await load()
    expect((await s.entries(7)).console).toHaveLength(1)
    expect(await s.captureState(7)).toMatchObject({ state: 'armed' })
  })

  it('keeps the newest 500 of each kind per tab, and clears on close', async () => {
    const s = await load()
    await s.armTab(7, 'https://app.example.org/', async () => 'n1')
    for (let i = 0; i < 6; i++) await s.appendEntries(7, Array.from({ length: 100 }, (_, j) => e(i * 100 + j)))
    const got = await s.entries(7)
    expect(got.console).toHaveLength(500)
    expect(got.console[0]!.t).toBe(100)
    await s.onTabRemoved(7)
    expect(await s.captureState(7)).toEqual({ state: 'off' })
    expect((await s.entries(7)).console).toEqual([])
  })
})
