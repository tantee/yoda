import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerCapability, RunUsage } from '@yoda/shared'
import { withMcpConfigFile, type RunnerConfig } from './config.js'
import { McpToolError, type CoreClient, type RunCode } from './core.js'
import type { Executor, ExecutorResult } from './executors/index.js'
import { commitLeftovers, hasNewCommits, prepareWorkspace, pushBranch, scrub, type Workspace } from './git.js'
import { buildPrompt } from './prompt.js'

export type WorkDeps = {
  cfg: RunnerConfig
  core: CoreClient
  executor: Executor
  log?: (line: string) => void
  /** Aborted when the runner stops: the executor is aborted and the run released (`failed: false`). */
  signal?: AbortSignal
}

/** A task to claim, or a run the loop already claimed. `capability` is the template's, when known. */
export type WorkTarget =
  | { taskId: string; capability?: RunnerCapability }
  | { runId: string; alreadyClaimed: true; capability?: RunnerCapability }

export type WorkResult =
  | { status: 'submitted'; runId: string; outcome: string; mrUrl: string | null }
  /** The agent asked a person, or core ended the run meanwhile (`run_not_active`): nothing pushed or released. */
  | { status: 'parked'; runId: string }
  | { status: 'failed'; runId: string; error: string }
  /** The runner stopped: released with `failed: false`. */
  | { status: 'stopped'; runId: string }

export const HEARTBEAT_MS = 60_000
const LEFTOVERS_MESSAGE = 'yoda: uncommitted changes from agent run'
/** Capabilities whose result is a merge request; the others submit their summary only. */
const CODE_CAPABILITIES: RunnerCapability[] = ['code-change']

const runNotActive = (err: unknown) => err instanceof McpToolError && err.code === 'invalid_state' && err.reason === 'run_not_active'

/** An error for `release_task`: one line, no clone credentials or runner token, at most 500 chars. */
export function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const text = scrub(raw)
    .replace(/yoda_rt_[A-Za-z0-9_-]+/g, 'yoda_rt_…')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || 'runner error').slice(0, 500)
}

// Git operations on one clone (fetch, worktree add / remove, push) run one at a time.
const repoLocks = new Map<string, Promise<unknown>>()
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.catch(() => undefined)
  repoLocks.set(key, settled)
  void settled.then(() => {
    if (repoLocks.get(key) === settled) repoLocks.delete(key)
  })
  return next
}

/** The work item's title from the context pack (`# Work item` then `**title**`), for the MR title. */
function mrTitle(packText: string, summary: string): string {
  const m = /^# Work item\s*\n+\*\*(.+?)\*\*/m.exec(packText)
  const title = (m?.[1] ?? summary.split('\n')[0] ?? '').trim()
  return (title || 'Yoda runner change').slice(0, 200)
}

/**
 * The repo this run works. The first version works one repo per run: the first with a default branch. The
 * context pack carries no MR state, so "the first without a merged MR" cannot be told apart yet.
 */
function pickRepo(code: RunCode): { repo: RunCode['repos'][number] | undefined; note: string | null } {
  const repo = code.repos.find((r) => r.defaultBranch) ?? code.repos[0]
  const others = code.repos.filter((r) => r !== repo).map((r) => r.path)
  const note = repo && others.length ? `Note: this runner works one repository per run; it worked ${repo.path} only (also linked: ${others.join(', ')}).` : null
  return { repo, note }
}

class Stop extends Error {
  constructor(readonly result: WorkResult) {
    super(result.status)
  }
}

/**
 * Works one task end to end: claim (unless already claimed), heartbeat every 60 s, context pack, a worktree for
 * the run's repo, the executor, then push + MR (code changes with new commits) and `submit_result`. A parked or
 * ended run stops with nothing pushed; a failure is released `failed: true`; a stop is released `failed: false`.
 * The worktree is always removed and the heartbeat stopped. A claim refusal is thrown (`McpToolError`).
 */
export async function workTask(deps: WorkDeps, target: WorkTarget): Promise<WorkResult> {
  const { cfg, core, executor } = deps
  const log = deps.log ?? (() => undefined)
  const runId = 'runId' in target ? target.runId : (await core.claimTask({ taskId: target.taskId })).runId
  log(`run ${runId}: claimed`)

  const ended = new AbortController()
  const signal = deps.signal ? AbortSignal.any([deps.signal, ended.signal]) : ended.signal
  const heartbeat = setInterval(() => {
    core.heartbeat({ runId }).catch((err: unknown) => {
      if (runNotActive(err)) {
        log(`run ${runId}: no longer active in core (parked or expired); stopping`)
        ended.abort()
      } else {
        log(`run ${runId}: heartbeat failed: ${shortError(err)}`)
      }
    })
  }, HEARTBEAT_MS)

  let workspace: Workspace | undefined
  let scratch: string | undefined
  let lockKey = ''
  const release = async (failed: boolean, reason: string) => {
    try {
      await core.releaseTask({ runId, failed, reason })
    } catch (err) {
      if (!runNotActive(err)) log(`run ${runId}: release failed: ${shortError(err)}`)
    }
  }
  const stopped = (): WorkResult => ({ status: 'stopped', runId })
  /** A core call on the run; `run_not_active` means the run was parked or ended: stop without a release. */
  const onRun = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (runNotActive(err)) throw new Stop({ status: 'parked', runId })
      throw err
    }
  }

  try {
    const pack = await onRun(() => core.getContextPack({ runId }))
    const { repo, note } = pickRepo(pack.code)
    const code = target.capability ? CODE_CAPABILITIES.includes(target.capability) : !!repo
    let dir: string
    if (repo) {
      lockKey = repo.path
      workspace = await withRepoLock(lockKey, () => prepareWorkspace(cfg, repo, pack.code.branch, { runId }))
      dir = workspace.dir
    } else if (code) {
      throw new Error('no repository is linked to this work item')
    } else {
      scratch = join(cfg.workRoot, runId, 'scratch')
      await mkdir(scratch, { recursive: true })
      dir = scratch
    }

    if (deps.signal?.aborted) {
      await release(false, 'runner_stopped')
      return stopped()
    }

    const result: ExecutorResult = await withMcpConfigFile(cfg, (mcpConfigPath) =>
      executor.run({ dir, prompt: buildPrompt(pack, runId), mcpConfigPath, timeoutMs: cfg.maxTurnsMinutes * 60_000, signal }),
    )
    if (ended.signal.aborted || result.needsHuman) {
      log(`run ${runId}: waiting for a person`)
      return { status: 'parked', runId }
    }
    if (!result.ok) {
      if (deps.signal?.aborted) {
        await release(false, 'runner_stopped')
        return stopped()
      }
      const error = shortError(result.summary || 'executor failed')
      await release(true, error)
      return { status: 'failed', runId, error }
    }
    // The agent may have asked a person without the marker: core parked the run, so nothing is pushed.
    await onRun(() => core.heartbeat({ runId })).catch((err: unknown) => {
      if (err instanceof Stop) throw err
      log(`run ${runId}: heartbeat failed: ${shortError(err)}`)
    })

    let mrUrl: string | null = null
    if (code && repo && workspace) {
      const ws = workspace
      const base = `origin/${repo.defaultBranch}`
      await commitLeftovers(ws.dir, LEFTOVERS_MESSAGE)
      if (await hasNewCommits(ws.dir, base)) {
        await withRepoLock(lockKey, () => pushBranch(ws.dir, pack.code.branch, repo.defaultBranch!))
        log(`run ${runId}: pushed ${pack.code.branch}`)
        const mr = await onRun(() =>
          core.openMergeRequest({
            runId,
            repoId: repo.repoId,
            sourceBranch: pack.code.branch,
            title: mrTitle(pack.text, result.summary),
            description: result.summary.slice(0, 20000),
          }),
        )
        mrUrl = mr.url
        log(`run ${runId}: merge request ${mr.url}`)
      }
    }

    const text = [result.summary.trim() || 'Done.', mrUrl ? `Merge request: ${mrUrl}` : null, note].filter(Boolean).join('\n\n')
    const usage: RunUsage | undefined = result.usage
    const { outcome } = await onRun(() => core.submitResult({ runId, text: text.slice(0, 50000), ...(usage ? { usage } : {}) }))
    log(`run ${runId}: submitted (${outcome})`)
    return { status: 'submitted', runId, outcome, mrUrl }
  } catch (err) {
    if (err instanceof Stop) {
      log(`run ${runId}: run no longer active in core; stopping`)
      return err.result
    }
    const error = shortError(err)
    log(`run ${runId}: failed: ${error}`)
    await release(true, error)
    return { status: 'failed', runId, error }
  } finally {
    clearInterval(heartbeat)
    if (workspace) {
      const ws = workspace
      await withRepoLock(lockKey, () => ws.cleanup())
    }
    if (scratch) await rm(join(cfg.workRoot, runId), { recursive: true, force: true }).catch(() => undefined)
  }
}
