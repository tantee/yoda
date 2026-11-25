import { sql } from 'drizzle-orm'
import type { AppDeps } from './app.js'

export type CheckName = 'db' | 'storage' | 'queue'
export type Readiness = { ok: boolean; checks: Record<CheckName, 'ok' | 'fail'> }

export const READY_TIMEOUT_MS = 2000

/** Resolves when `fn` succeeds within `ms`; a throw, a falsy result or the timeout is a failure. */
async function probe(fn: () => Promise<unknown>, ms: number): Promise<'ok' | 'fail'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    const passed = await Promise.race([fn().then((v) => v !== false), timeout])
    return passed ? 'ok' : 'fail'
  } catch {
    return 'fail'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the app can serve: the database answers `select 1`, the storage bucket is reachable, and the job
 * queue is running. Checks run in parallel, each with its own timeout. Errors are swallowed, never echoed.
 */
export async function readiness(
  deps: Pick<AppDeps, 'db' | 'storage' | 'jobs'>,
  opts: { timeoutMs?: number } = {},
): Promise<Readiness> {
  const ms = opts.timeoutMs ?? READY_TIMEOUT_MS
  const [db, storage, queue] = await Promise.all([
    probe(() => deps.db.execute(sql`select 1`), ms),
    probe(() => deps.storage.ping(), ms),
    probe(async () => deps.jobs.started(), ms),
  ])
  const checks = { db, storage, queue }
  return { ok: Object.values(checks).every((c) => c === 'ok'), checks }
}
