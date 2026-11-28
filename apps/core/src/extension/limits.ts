import { RateLimiter } from '../settings/rate-limit.js'

const MIN = 60_000
const HOUR = 60 * MIN

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
    /** Session reads per grant. */
    session: new RateLimiter([{ max: 120, windowMs: HOUR }], now),
  }
}

export type ExtensionLimits = ReturnType<typeof extensionLimits>
