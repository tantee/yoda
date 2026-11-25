import { McpToolError } from './core.js'
import { shortError, workTask, type WorkDeps, type WorkResult } from './work.js'

export type LoopDeps = Omit<WorkDeps, 'signal'> & {
  /** Aborted on SIGINT / SIGTERM (see `stopOnSignals`): polling stops and running work is released. */
  signal?: AbortSignal
  /** Waits between polls (tests replace it); resolves early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Claim refusals that pass with time or an admin's action: wait for the next poll. */
const WAIT = new Set(['outside_hours', 'runner_paused', 'all_runners_paused', 'at_capacity'])
/** Refusals after which polling cannot succeed: exit (code 1). */
const FATAL = new Set(['runner_revoked'])

export const EXIT_PERSONAL_UNATTENDED = 2
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
 * `at_capacity` refusal is the source of truth for the runner's real limit. Returns the exit code: 0 when stopped
 * (or after one poll with `once`, once its work is done), 2 for `personal_unattended_not_allowed` or an on-demand
 * runner (`on_demand_runner`), 1 for a revoked
 * runner or a rejected token.
 */
export async function startLoop(deps: LoopDeps, opts: { once?: boolean } = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => void process.stderr.write(`${l}\n`))
  const sleep = deps.sleep ?? defaultSleep
  const signal = deps.signal
  const active = new Set<Promise<WorkResult | void>>()
  const max = deps.cfg.maxConcurrent
  let exit = 0

  const startWork = (runId: string, capability: Parameters<typeof workTask>[1]['capability']) => {
    const p = workTask({ ...deps, log, signal }, { runId, alreadyClaimed: true, capability })
      .catch((err: unknown) => log(`run ${runId}: ${shortError(err)}`))
      .finally(() => active.delete(p))
    active.add(p)
  }

  /** One poll; returns an exit code to stop with, or null to keep going. */
  const poll = async (): Promise<number | null> => {
    if (active.size >= max) return null
    const { tasks } = await deps.core.listAvailableTasks({})
    for (const task of tasks) {
      if (active.size >= max || signal?.aborted) break
      try {
        const { runId } = await deps.core.claimTask({ taskId: task.taskId })
        startWork(runId, task.capability)
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

  while (!signal?.aborted) {
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
    await sleep(deps.cfg.pollSeconds * 1000, signal)
  }
  // On a stop, each running workTask sees the aborted signal, aborts its executor and releases its run.
  await Promise.all([...active])
  return exit
}
