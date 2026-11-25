import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
  if (!source) throw new Error(`no local clone configured for ${path} (add it to "repos" in the runner config)`)
  if ('clonePath' in source) {
    if (!existsSync(source.clonePath)) throw new Error(`clonePath for ${path} does not exist: ${source.clonePath}`)
    return source.clonePath
  }
  const segments = path.split('/')
  if (!segments.every(safeSegment)) throw new Error(`unsafe repo path: ${path}`)
  const dir = join(cfg.workRoot, 'clones', ...segments)
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true })
    await git(dirname(dir), ['clone', '--quiet', '--', source.cloneUrl, dir])
  }
  return dir
}

export type Workspace = { dir: string; cleanup(): Promise<void> }

/**
 * Fetches origin in the repo's clone and adds a worktree at `<workRoot>/<runId>/<repo-slug>` on `branch`, reset
 * to `origin/<defaultBranch>`. `cleanup` removes the worktree, its dir and the local branch; it never throws.
 */
export async function prepareWorkspace(
  cfg: RunnerConfig,
  repo: Repo,
  branch: string,
  opts: { runId?: string } = {},
): Promise<Workspace> {
  if (!repo.defaultBranch) throw new Error(`${repo.path} has no default branch`)
  checkRunnerBranch(branch, repo.defaultBranch)
  const runId = opts.runId ?? randomUUID()
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('invalid run id')
  const clone = await ensureClone(cfg, repo.path)
  await git(clone, ['fetch', '--quiet', '--prune', 'origin'])
  await git(clone, ['worktree', 'prune'])
  const base = `refs/remotes/origin/${repo.defaultBranch}`
  await git(clone, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).catch(() => {
    throw new Error(`origin/${repo.defaultBranch} not found in ${repo.path}`)
  })

  const runDir = join(cfg.workRoot, runId)
  const dir = join(runDir, repoSlug(repo.path))
  let added = false
  const cleanup = async () => {
    if (added) await git(clone, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    if (existsSync(runDir) && (await readdir(runDir).catch(() => ['?'])).length === 0) await rmdir(runDir).catch(() => undefined)
    await git(clone, ['worktree', 'prune']).catch(() => undefined)
    if (added) await git(clone, ['branch', '-D', branch]).catch(() => undefined)
    added = false
  }
  try {
    await mkdir(runDir, { recursive: true })
    await git(clone, ['worktree', 'add', '--quiet', '--no-track', '-B', branch, dir, base])
    added = true
  } catch (err) {
    await cleanup()
    throw err
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
