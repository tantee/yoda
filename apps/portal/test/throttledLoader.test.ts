import { describe, expect, it } from 'vitest'
import { throttledLoader } from '../app/utils/throttledLoader'

function setup(gap = 20000) {
  let clock = 0
  let calls = 0
  const pending: (() => void)[] = []
  const load = throttledLoader(() => {
    calls++
    return new Promise<void>((resolve) => pending.push(resolve))
  }, gap, () => clock)
  const settle = async () => {
    while (pending.length) pending.shift()!()
    await new Promise(r => setTimeout(r, 0))
  }
  return { load, settle, calls: () => calls, tick: (ms: number) => { clock += ms } }
}

describe('throttledLoader', () => {
  it('skips a load within the gap after the last completed one', async () => {
    const s = setup()
    const a = s.load()
    await s.settle()
    await a
    s.tick(19000)
    await s.load()
    expect(s.calls()).toBe(1)
    s.tick(2000)
    const b = s.load()
    await s.settle()
    await b
    expect(s.calls()).toBe(2)
  })

  it('a forced load ignores the gap', async () => {
    const s = setup()
    const a = s.load()
    await s.settle()
    await a
    const b = s.load({ force: true })
    await s.settle()
    await b
    expect(s.calls()).toBe(2)
  })

  it('shares the request in flight', async () => {
    const s = setup()
    const a = s.load()
    const b = s.load()
    expect(s.calls()).toBe(1)
    await s.settle()
    await Promise.all([a, b])
    expect(s.calls()).toBe(1)
  })

  it('a forced load during a request loads again afterwards', async () => {
    const s = setup()
    const a = s.load()
    const b = s.load({ force: true })
    expect(s.calls()).toBe(1)
    await s.settle()
    await a
    await s.settle()
    await b
    expect(s.calls()).toBe(2)
  })

  it('a failed load still counts as completed and does not stick', async () => {
    let clock = 0
    let calls = 0
    const load = throttledLoader(async () => {
      calls++
      throw new Error('down')
    }, 1000, () => clock)
    await expect(load()).rejects.toThrow('down')
    await load()
    expect(calls).toBe(1)
    clock += 1001
    await expect(load()).rejects.toThrow('down')
    expect(calls).toBe(2)
  })
})
