import { RateLimiter } from '../settings/rate-limit.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Declared upload bytes per key over a sliding 24 hours; a failed upload gives its bytes back. */
export class DailyBytes {
  private used = new Map<string, { at: number; bytes: number }[]>()

  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts `bytes` for `key`, or says how many seconds until they fit. */
  take(key: string, bytes: number): { ok: true; release: () => void } | { ok: false; retryAfter: number } {
    const now = this.now()
    const kept = (this.used.get(key) ?? []).filter((u) => u.at > now - DAY)
    let total = kept.reduce((n, u) => n + u.bytes, 0)
    if (total + bytes > this.max) {
      // The wait until enough of the oldest uploads leave the window.
      let i = 0
      while (i < kept.length && total + bytes > this.max) total -= kept[i++]!.bytes
      this.used.set(key, kept)
      const until = i > 0 ? kept[i - 1]!.at + DAY : now + DAY
      return { ok: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) }
    }
    // Keeps the map small: drop keys with nothing left in the window.
    if (this.used.size > 1000) for (const [k, list] of this.used) if (!list.some((u) => u.at > now - DAY)) this.used.delete(k)
    const entry = { at: now, bytes }
    kept.push(entry)
    this.used.set(key, kept)
    return {
      ok: true,
      release: () => {
        const list = this.used.get(key)
        const at = list?.indexOf(entry) ?? -1
        if (list && at >= 0) list.splice(at, 1)
        if (list && !list.length) this.used.delete(key)
      },
    }
  }
}

/**
 * The `/extension/*` rate limits (plan A3), per app instance. `codeFailures` and `refreshFailures` count only failed
 * attempts: they are checked with `check` before the attempt and taken only when it fails.
 */
export function extensionLimits(now: () => number = Date.now) {
  return {
    /** Token calls per IP: generous, for one hospital NAT. */
    token: new RateLimiter([{ max: 120, windowMs: MIN }], now),
    /** Failed code exchanges per IP. */
    codeFailures: new RateLimiter([{ max: 5, windowMs: 15 * MIN }], now),
    /** Failed refreshes per token family (an unknown refresh token counts only against `token`). */
    refreshFailures: new RateLimiter([{ max: 5, windowMs: 15 * MIN }], now),
    /** Codes minted per person. */
    authorize: new RateLimiter([{ max: 10, windowMs: HOUR }], now),
    /** Session reads per grant (the mappings read counts here too). */
    session: new RateLimiter([{ max: 120, windowMs: HOUR }], now),
    /** Defect reports per person. */
    defects: new RateLimiter([{ max: 20, windowMs: HOUR }, { max: 100, windowMs: DAY }], now),
    /** Declared defect bytes per person: 300 MB a day. */
    defectBytes: new DailyBytes(300_000_000, now),
  }
}

export type ExtensionLimits = ReturnType<typeof extensionLimits>
