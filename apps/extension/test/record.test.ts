import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRecordClick } from '../src/popup/record'
import { installChrome, type FakeChrome } from './support/chrome'

let c: FakeChrome
beforeEach(() => {
  c = installChrome()
})

describe('the Record click', () => {
  it('the popup requests tabCapture before any await, then starts the clip', async () => {
    const order: string[] = []
    const request = vi.fn(async (p: { permissions?: string[] }) => {
      order.push(`request:${(p.permissions ?? []).join(',')}`)
      return true
    })
    ;(c.permissions as unknown as { request: typeof request }).request = request
    const start = vi.fn(async () => {
      order.push('start')
      return { ok: true }
    })
    const p = onRecordClick(start)
    // Synchronously, inside the click: the request is already made, the start is not.
    expect(order).toEqual(['request:tabCapture'])
    expect(await p).toEqual({ ok: true })
    expect(order).toEqual(['request:tabCapture', 'start'])
  })

  it('a refused permission starts nothing', async () => {
    ;(c.permissions as unknown as { request: () => Promise<boolean> }).request = async () => false
    const start = vi.fn()
    expect(await onRecordClick(start)).toEqual({ ok: false, error: 'permission_needed' })
    expect(start).not.toHaveBeenCalled()
  })
})
