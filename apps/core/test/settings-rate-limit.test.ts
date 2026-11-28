import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/settings/rate-limit.js'

describe('RateLimiter', () => {
  it('applies every window per key and says when to retry', () => {
    let now = 0
    const rl = new RateLimiter(
      [
        { max: 10, windowMs: 60_000 },
        { max: 60, windowMs: 3_600_000 },
      ],
      () => now,
    )
    for (let i = 0; i < 10; i++) expect(rl.take('a')).toEqual({ ok: true })
    expect(rl.take('a')).toEqual({ ok: false, retryAfter: 60 })
    expect(rl.take('b')).toEqual({ ok: true })
    // The minute window frees up; refused calls did not count.
    now = 60_001
    expect(rl.take('a')).toEqual({ ok: true })
    // 60 an hour: fill five more minutes, then the hour window refuses.
    for (let m = 1; m <= 5; m++) {
      now = m * 60_001 + 1
      while (rl.take('a').ok) {}
    }
    now = 7 * 60_001
    const r = rl.take('a')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.retryAfter).toBeGreaterThan(60)
    now = 3_600_000 + 60_001 * 6
    expect(rl.take('a')).toEqual({ ok: true })
  })

  it('check reports the wait without consuming', () => {
    let now = 0
    const rl = new RateLimiter([{ max: 2, windowMs: 60_000 }], () => now)
    for (let i = 0; i < 5; i++) expect(rl.check('a')).toEqual({ ok: true })
    expect(rl.take('a')).toEqual({ ok: true })
    expect(rl.take('a')).toEqual({ ok: true })
    now = 10_000
    expect(rl.check('a')).toEqual({ ok: false, retryAfter: 50 })
    expect(rl.check('b')).toEqual({ ok: true })
    now = 60_001
    expect(rl.check('a')).toEqual({ ok: true })
  })

  it('check after take sees the take', () => {
    const rl = new RateLimiter([{ max: 1, windowMs: 60_000 }], () => 0)
    expect(rl.check('a')).toEqual({ ok: true })
    expect(rl.take('a')).toEqual({ ok: true })
    expect(rl.check('a')).toEqual({ ok: false, retryAfter: 60 })
    expect(rl.take('a')).toEqual({ ok: false, retryAfter: 60 })
  })
})
