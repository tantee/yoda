import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { RunnerConfig } from './config.js'
import type { RunCode } from './core.js'

type Repo = RunCode['repos'][number]

/** The branches a runner may create and push: `yoda/<8 hex>-<slug>` (core: runners/merge-requests.ts). */
export const RUNNER_BRANCH = /^yoda\/[0-9a-f]{8}-[a-z0-9-]{1,60}$/

export type PushRefusal = 'default_branch' | 'not_runner_branch' | 'detached_head' | 'head_not_on_branch'

/** The runner refused to create or push a branch. Nothing was sent to the remote. */
export class PushRefused extends Error {
  override name = 'PushRefused'
  constructor(
    readonly reason: PushRefusal,
    detail?: string,
  ) {
    super(detail ? `push refused (${reason}): ${detail}` : `push refused (${reason})`)
  }
}

/** Strips `user:password@` from URLs, so git errors and `config show` never carry clone credentials. */
export const scrub = (s: string) => s.replace(/(\/\/)[^/@\s]+@/g, '$1***@')

/** A git command failed (its message has clone credentials removed). */
export class GitError extends Error {
  override name = 'GitError'
}

/**
 * This machine cannot work the run (no clone configured, a clone or fetch failed, a worktree is in the way, the
 * executor is not installed): not the task's fault, so the run is released without a strike. `fatal` means no
 * run can succeed until someone fixes the runner (the loop exits).
 */
export class EnvironmentError extends Error {
  override name = 'EnvironmentError'
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message)
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new GitError(scrub(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`)))
      else resolve(String(stdout).trim())
    })
  })
}

const safeSegment = (s: string) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'

/** `group/sub/repo` → `group-sub-repo`. */
const repoSlug = (path: string) => path.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'repo'

function checkRunnerBranch(branch: string, defaultBranch: string | null): void {
  if (branch === defaultBranch) throw new PushRefused('default_branch', branch)
  if (!RUNNER_BRANCH.test(branch)) throw new PushRefused('not_runner_branch', branch)
}

/** The local clone for `path`: the configured clonePath, or `<workRoot>/clones/<path>`, cloned on first use. */
async function ensureClone(cfg: RunnerConfig, path: string): Promise<string> {
  const source = Object.hasOwn(cfg.repos, path) ? cfg.repos[path] : undefined
  if (!source) throw new EnvironmentError(`no local clone configured for ${path} (add it to "repos" in the runner config)`)
  if ('clonePath' in source) {
    if (!existsSync(source.clonePath)) throw new EnvironmentError(`clonePath for ${path} does not exist: ${source.clonePath}`)
    return source.clonePath
  }
  const segments = path.split('/')
  if (!segments.every(safeSegment)) throw new EnvironmentError(`unsafe repo path: ${path}`)
  const dir = join(cfg.workRoot, 'clones', ...segments)
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    await git(dirname(dir), ['clone', '--quiet', '--', source.cloneUrl, dir])
  }
  return dir
}

export type Workspace = { dir: string; cleanup(): Promise<void> }

/** Worktree dirs of runs this process is working now; any other worktree under workRoot is left over. */
const activeWorktrees = new Set<string>()

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const isInside = (root: string, p: string) => {
  const rel = relative(real(root), real(p))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** `git worktree list --porcelain`: each worktree's path and branch (null when detached); the main one first. */
async function worktrees(clone: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await git(clone, ['worktree', 'list', '--porcelain'])
  return out
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n')
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
      const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null
      return path ? { path, branch } : null
    })
    .filter((w): w is { path: string; branch: string | null } => w !== null)
}

/**
 * Makes room for a worktree on `branch`: a worktree on it under workRoot that no run of this process is using
 * was left by a killed run, and is removed. On it anywhere else (the main checkout, a worktree of the person's
 * own), or in use by a run of this process, is an `EnvironmentError`.
 */
async function freeBranch(cfg: RunnerConfig, clone: string, branch: string): Promise<void> {
  const ref = `refs/heads/${branch}`
  const list = await worktrees(clone)
  for (const [i, w] of list.entries()) {
    if (w.branch !== ref) continue
    if (i === 0 || !isInside(cfg.workRoot, w.path)) {
      throw new EnvironmentError(
        `branch ${branch} is checked out at ${w.path}, outside the runner's workRoot; switch that checkout to another branch or remove the worktree`,
      )
    }
    if ([...activeWorktrees].some((d) => real(d) === real(w.path))) {
      throw new EnvironmentError(`branch ${branch} is in use by another run of this runner`)
    }
    await git(clone, ['worktree', 'remove', '--force', w.path]).catch(() => undefined)
    await rm(w.path, { recursive: true, force: true }).catch(() => undefined)
    const parent = dirname(w.path)
    if (isInside(cfg.workRoot, parent) && (await readdir(parent).catch(() => ['?'])).length === 0) await rmdir(parent).catch(() => undefined)
  }
  await git(clone, ['worktree', 'prune'])
}

/**
 * Fetches origin in the repo's clone and adds a worktree at `<workRoot>/<runId>/<repo-slug>` on `branch`, reset
 * to `origin/<branch>` when origin already has it (an earlier run pushed it), else to `origin/<defaultBranch>`.
 * With `detach` (runs that push nothing) the worktree is a detached HEAD at `origin/<defaultBranch>` instead.
 * A worktree a killed run left on the branch is removed first. `cleanup` removes the worktree, its dir and the
 * local branch; it never throws. Failures of this machine (clone, fetch, worktree) are `EnvironmentError`s.
 */
export async function prepareWorkspace(
  cfg: RunnerConfig,
  repo: Repo,
  branch: string,
  opts: { runId?: string; detach?: boolean } = {},
): Promise<Workspace> {
  if (!repo.defaultBranch) throw new Error(`${repo.path} has no default branch`)
  checkRunnerBranch(branch, repo.defaultBranch)
  const runId = opts.runId ?? randomUUID()
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('invalid run id')
  const detach = opts.detach ?? false
  const env = <T>(p: Promise<T>) =>
    p.catch((err: unknown) => {
      throw err instanceof EnvironmentError ? err : new EnvironmentError(err instanceof Error ? err.message : String(err))
    })
  const clone = await env(ensureClone(cfg, repo.path))
  await env(git(clone, ['fetch', '--quiet', '--prune', 'origin']))
  await env(git(clone, ['worktree', 'prune']))
  const defaultBase = `refs/remotes/origin/${repo.defaultBranch}`
  await git(clone, ['rev-parse', '--verify', '--quiet', `${defaultBase}^{commit}`]).catch(() => {
    throw new EnvironmentError(`origin/${repo.defaultBranch} not found in ${repo.path}`)
  })
  // A previous run of this work item may have pushed the branch (then failed before its MR, or was parked):
  // continue from it, so new commits fast-forward and the push succeeds.
  const remoteBranch = `refs/remotes/origin/${branch}`
  const continued =
    !detach &&
    (await git(clone, ['rev-parse', '--verify', '--quiet', `${remoteBranch}^{commit}`]).then(
      () => true,
      () => false,
    ))
  const base = continued ? remoteBranch : defaultBase
  if (!detach) await env(freeBranch(cfg, clone, branch))

  const runDir = join(cfg.workRoot, runId)
  const dir = join(runDir, repoSlug(repo.path))
  let added = false
  const cleanup = async () => {
    activeWorktrees.delete(dir)
    if (added) await git(clone, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    if (existsSync(runDir) && (await readdir(runDir).catch(() => ['?'])).length === 0) await rmdir(runDir).catch(() => undefined)
    await git(clone, ['worktree', 'prune']).catch(() => undefined)
    if (added && !detach) await git(clone, ['branch', '-D', branch]).catch(() => undefined)
    added = false
  }
  try {
    await mkdir(runDir, { recursive: true })
    const args = detach ? ['--detach', dir, defaultBase] : ['--no-track', '-B', branch, dir, base]
    await git(clone, ['worktree', 'add', '--quiet', ...args])
    added = true
    activeWorktrees.add(dir)
  } catch (err) {
    await cleanup()
    throw err instanceof EnvironmentError ? err : new EnvironmentError(err instanceof Error ? err.message : String(err))
  }
  return { dir, cleanup }
}

/**
 * Pushes `branch` to origin as `refs/heads/<branch>` (an explicit refspec, so push config cannot redirect it).
 * Refused, before anything is sent, for the default branch, a non-runner branch, a detached HEAD, or a HEAD
 * that is on another branch.
 */
export async function pushBranch(dir: string, branch: string, defaultBranch: string): Promise<void> {
  checkRunnerBranch(branch, defaultBranch)
  const head = await git(dir, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null)
  if (head === null) throw new PushRefused('detached_head')
  if (head !== `refs/heads/${branch}`) throw new PushRefused('head_not_on_branch', head)
  const ref = `refs/heads/${branch}`
  await git(dir, ['push', '--quiet', '--set-upstream', 'origin', `${ref}:${ref}`])
}

/** Whether HEAD has commits that `base` (e.g. `origin/main`) does not. */
export async function hasNewCommits(dir: string, base: string): Promise<boolean> {
  return Number(await git(dir, ['rev-list', '--count', `${base}..HEAD`])) > 0
}

/**
 * Commits whatever the agent left uncommitted (`git add -A`, so .gitignore applies) on the current branch.
 * Returns whether it made a commit. The push guard still checks the branch afterwards.
 */
export async function commitLeftovers(dir: string, message: string): Promise<boolean> {
  if (!(await git(dir, ['status', '--porcelain']))) return false
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--quiet', '-m', message])
  return true
}
