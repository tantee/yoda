import type { AvailableTask } from '@yoda/shared'
import { McpToolError } from './core.js'
import { shortError, workTask, type WorkDeps, type WorkResult } from './work.js'

export type LoopDeps = Omit<WorkDeps, 'signal'> & {
  /** Aborted on SIGINT / SIGTERM (see `stopOnSignals`): polling stops and running work is released. */
  signal?: AbortSignal
  /** Waits between polls (tests replace it); resolves early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Clock for the skip list (tests replace it). */
  now?: () => number
}

/** Claim refusals that pass with time or an admin's action: wait for the next poll. */
const WAIT = new Set(['outside_hours', 'runner_paused', 'all_runners_paused', 'at_capacity'])
/** Refusals after which polling cannot succeed: exit (code 1). */
const FATAL = new Set(['runner_revoked'])

export const EXIT_PERSONAL_UNATTENDED = 2
/** This machine cannot work any task until fixed (e.g. the executor is not installed). */
export const EXIT_ENVIRONMENT = 3
/** A task this runner gave back (failed, or this machine could not work it) is not claimed again for this long. */
export const SKIP_MS = 10 * 60_000
/** The runner is on demand in the portal: it may not poll the queue. */
export const EXIT_ON_DEMAND = 2

const ON_DEMAND_MESSAGE =
  'this runner is set to on demand in the portal, so it may not poll for tasks. Use `yoda-runner work <taskId>`, ' +
  'or set the runner to unattended in the portal.'

const PERSONAL_MESSAGE =
  'this runner uses a personal subscription, which may not work tasks unattended. Use `yoda-runner work <taskId>` ' +
  'on demand, or ask an admin to allow personal subscriptions unattended (after checking the provider terms).'

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/** Aborts `controller` on SIGINT / SIGTERM. Returns a function that removes the handlers. */
export function stopOnSignals(
  controller: AbortController,
  proc: Pick<NodeJS.EventEmitter, 'on' | 'off'> = process,
): () => void {
  const onSignal = () => controller.abort()
  proc.on('SIGINT', onSignal)
  proc.on('SIGTERM', onSignal)
  return () => {
    proc.off('SIGINT', onSignal)
    proc.off('SIGTERM', onSignal)
  }
}

/**
 * Unattended mode. Each poll lists available tasks and claims and works up to `cfg.maxConcurrent` at once; core's
 * `at_capacity` refusal is the source of truth for the runner's real limit. A task whose run failed or that this
 * machine could not work is skipped for `SKIP_MS`. Returns the exit code: 0 when stopped (or after one poll with
 * `once`, once its work is done), 2 for `personal_unattended_not_allowed` or an on-demand runner
 * (`on_demand_runner`), 3 when this machine cannot work tasks (a fatal `EnvironmentError`, e.g. the executor is
 * not installed), 1 for a revoked runner or a rejected token.
 */
export async function startLoop(deps: LoopDeps, opts: { once?: boolean } = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stderr.write(`${l}\n`))
  const sleep = deps.sleep ?? defaultSleep
  const signal = deps.signal
  const now = deps.now ?? Date.now
  const active = new Set<Promise<WorkResult | void>>()
  const max = deps.cfg.maxConcurrent
  /** Task id → when it may be claimed again (in-process only). */
  const skipUntil = new Map<string, number>()
  /** Set when a run hit a fatal environment error: no more claims, and the loop exits with code 3. */
  const fatal = new AbortController()
  const sleepSignal = signal ? AbortSignal.any([signal, fatal.signal]) : fatal.signal
  let exit = 0

  const startWork = (task: AvailableTask, claim: { runId: string; leaseExpiresAt: string }) => {
    const { runId } = claim
    const p = workTask({ ...deps, log, signal }, { runId, alreadyClaimed: true, capability: task.capability, leaseExpiresAt: claim.leaseExpiresAt })
      .then((r) => {
        if (r.status === 'failed' || r.status === 'environment') skipUntil.set(task.taskId, now() + SKIP_MS)
        if (r.status === 'environment' && r.fatal && !fatal.signal.aborted) {
          log(`yoda-runner: stopping: this machine cannot work tasks until fixed (${r.error})`)
          fatal.abort()
        }
        return r
      })
      .catch((err: unknown) => log(`run ${runId}: ${shortError(err)}`))
      .finally(() => active.delete(p))
    active.add(p)
  }

  /** One poll; returns an exit code to stop with, or null to keep going. */
  const poll = async (): Promise<number | null> => {
    if (active.size >= max) return null
    const { tasks } = await deps.core.listAvailableTasks({})
    for (const [id, until] of skipUntil) if (until <= now()) skipUntil.delete(id)
    for (const task of tasks) {
      if (active.size >= max || signal?.aborted || fatal.signal.aborted) break
      if (skipUntil.has(task.taskId)) continue
      try {
        const claim = await deps.core.claimTask({ taskId: task.taskId })
        startWork(task, claim)
      } catch (err) {
        if (!(err instanceof McpToolError)) throw err
        const reason = err.reason ?? err.code
        if (reason === 'personal_unattended_not_allowed') {
          log(`yoda-runner: ${PERSONAL_MESSAGE}`)
          return EXIT_PERSONAL_UNATTENDED
        }
        if (err.code === 'unauthorized' || FATAL.has(reason)) {
          log(`yoda-runner: core refused the runner (${reason}); check the runner token in the portal`)
          return 1
        }
        if (WAIT.has(reason)) {
          log(`yoda-runner: not claiming now (${reason}); waiting for the next poll`)
          break
        }
        // already_claimed, task_unavailable, needs_decision, no_ai, budget_exceeded, not_found: try the next task.
        log(`yoda-runner: skipped task ${task.taskId} (${reason})`)
      }
    }
    return null
  }

  while (!signal?.aborted && !fatal.signal.aborted) {
    let code: number | null = null
    try {
      code = await poll()
    } catch (err) {
      if (err instanceof McpToolError && err.reason === 'on_demand_runner') {
        log(`yoda-runner: ${ON_DEMAND_MESSAGE}`)
        code = EXIT_ON_DEMAND
      } else if (err instanceof McpToolError && err.code === 'unauthorized') {
        log('yoda-runner: core rejected the runner token (revoked or wrong)')
        code = 1
      } else {
        log(`yoda-runner: poll failed: ${shortError(err)}`)
      }
    }
    if (code !== null) {
      exit = code
      break
    }
    if (opts.once) break
    await sleep(deps.cfg.pollSeconds * 1000, sleepSignal)
  }
  // On a stop, each running workTask sees the aborted signal, aborts its executor and releases its run.
  await Promise.all([...active])
  return fatal.signal.aborted && exit === 0 ? EXIT_ENVIRONMENT : exit
}
