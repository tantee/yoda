/**
 * In-memory sliding-window limits per key (installer proposal §8.4; one core process). Each limit is
 * `max` calls per `windowMs`; a call counts only when every limit lets it through.
 */
export type Limit = { max: number; windowMs: number }

export class RateLimiter {
  private hits = new Map<string, number[]>()
  private readonly longest: number

  constructor(
    private readonly limits: Limit[],
    private readonly now: () => number = Date.now,
  ) {
    this.longest = Math.max(...limits.map((l) => l.windowMs))
  }

  /** Counts one call for `key`, or says how many seconds until the next one is allowed. */
  take(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now()
    const kept = (this.hits.get(key) ?? []).filter((t) => t > now - this.longest)
    let wait = 0
    for (const l of this.limits) {
      const inWindow = kept.filter((t) => t > now - l.windowMs)
      if (inWindow.length >= l.max) wait = Math.max(wait, inWindow[inWindow.length - l.max]! + l.windowMs - now)
    }
    if (wait > 0) {
      this.hits.set(key, kept)
      return { ok: false, retryAfter: Math.max(1, Math.ceil(wait / 1000)) }
    }
    kept.push(now)
    this.hits.set(key, kept)
    // Keeps the map small: drop keys with nothing left in any window.
    if (this.hits.size > 1000) for (const [k, ts] of this.hits) if (!ts.some((t) => t > now - this.longest)) this.hits.delete(k)
    return { ok: true }
  }
}
