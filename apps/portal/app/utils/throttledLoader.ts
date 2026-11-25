/**
 * Wraps a loader so callers can ask often: `load()` skips when the last completed load is younger than
 * `minGapMs`, `load({ force: true })` always loads (after an action). Concurrent calls share the request in
 * flight; a forced call during a request waits for it, then loads again so it sees the action's effect.
 */
export function throttledLoader(fetch: () => Promise<void>, minGapMs: number, now: () => number = Date.now) {
  let inFlight: Promise<void> | null = null
  let lastDone = -Infinity

  function run(): Promise<void> {
    const p: Promise<void> = new Promise<void>(resolve => resolve(fetch())).finally(() => {
      lastDone = now()
      if (inFlight === p) inFlight = null
    })
    inFlight = p
    return p
  }

  return async function load(opts: { force?: boolean } = {}): Promise<void> {
    if (inFlight) {
      if (!opts.force) return inFlight
      await inFlight.catch(() => {})
      if (inFlight) return inFlight
      return run()
    }
    if (!opts.force && now() - lastDone < minGapMs) return
    return run()
  }
}
