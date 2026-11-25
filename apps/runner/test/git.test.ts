import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunnerConfig } from '../src/config.js'
import type { RunCode } from '../src/core.js'
import { commitLeftovers, hasNewCommits, prepareWorkspace, pushBranch, PushRefused } from '../src/git.js'
import { git, isolateGit, makeOrigin, tempDir, TOKEN } from './helpers.js'

const BRANCH = 'yoda/abcd1234-x'
const RUN_ID = '00000000-0000-4000-8000-000000000001'

const tmp = tempDir()
let origin: string
let clone: string

const repo = (over: Partial<RunCode['repos'][number]> = {}): RunCode['repos'][number] => ({
  repoId: '00000000-0000-4000-8000-0000000000aa',
  path: 'group/demo',
  webUrl: 'https://gitlab.example.invalid/group/demo',
  defaultBranch: 'main',
  issueIid: 1,
  issueUrl: null,
  ...over,
})

const cfgWith = (repos: RunnerConfig['repos']) =>
  RunnerConfig.parse({ coreUrl: 'http://core.invalid', token: TOKEN, workRoot: join(tmp.dir, 'work'), repos })

beforeAll(() => {
  isolateGit(tmp.dir)
  ;({ origin, clone } = makeOrigin(tmp.dir))
})
afterAll(() => tmp.remove())

function commitFile(dir: string, name: string): void {
  writeFileSync(join(dir, name), `${name}\n`)
  git(dir, 'add', name)
  git(dir, 'commit', '-q', '-m', `add ${name}`)
}

describe('prepareWorkspace', () => {
  it('creates a worktree on the runner branch from origin/main, and cleans it up', async () => {
    // The origin moves on after the clone was made: the worktree must start from the fetched origin/main.
    const other = join(tmp.dir, 'other')
    git(tmp.dir, 'clone', '-q', origin, other)
    commitFile(other, 'later.txt')
    git(other, 'push', '-q', 'origin', 'main')

    const ws = await prepareWorkspace(cfgWith({ 'group/demo': { clonePath: clone } }), repo(), BRANCH, { runId: RUN_ID })
    expect(ws.dir).toBe(join(tmp.dir, 'work', RUN_ID, 'group-demo'))
    expect(git(ws.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH)
    expect(git(ws.dir, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'))
    expect(existsSync(join(ws.dir, 'later.txt'))).toBe(true)
    expect(await hasNewCommits(ws.dir, 'origin/main')).toBe(false)
    commitFile(ws.dir, 'change.txt')
    expect(await hasNewCommits(ws.dir, 'origin/main')).toBe(true)

    await ws.cleanup()
    expect(existsSync(ws.dir)).toBe(false)
    expect(git(clone, 'worktree', 'list')).not.toContain(RUN_ID)
    expect(git(clone, 'branch', '--list', BRANCH)).toBe('')
    await ws.cleanup() // idempotent
  })

  it('clones a cloneUrl repo into workRoot/clones once', async () => {
    const cfg = cfgWith({ 'group/demo': { cloneUrl: origin } })
    const a = await prepareWorkspace(cfg, repo(), BRANCH)
    await a.cleanup()
    const cloned = join(tmp.dir, 'work', 'clones', 'group', 'demo')
    expect(existsSync(join(cloned, '.git'))).toBe(true)
    const b = await prepareWorkspace(cfg, repo(), BRANCH)
    expect(git(b.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH)
    await b.cleanup()
  })

  it('refuses unknown repos, missing default branches and non-runner branches', async () => {
    const cfg = cfgWith({ 'group/demo': { clonePath: clone } })
    await expect(prepareWorkspace(cfg, repo({ path: 'group/other' }), BRANCH)).rejects.toThrow(/group\/other/)
    await expect(prepareWorkspace(cfg, repo({ defaultBranch: null }), BRANCH)).rejects.toThrow(/default branch/)
    await expect(prepareWorkspace(cfg, repo(), 'main')).rejects.toBeInstanceOf(PushRefused)
    await expect(prepareWorkspace(cfg, repo(), 'feature/x')).rejects.toBeInstanceOf(PushRefused)
  })
})

describe('pushBranch', () => {
  it('pushes the runner branch to origin with an explicit refspec', async () => {
    const ws = await prepareWorkspace(cfgWith({ 'group/demo': { clonePath: clone } }), repo(), BRANCH)
    try {
      commitFile(ws.dir, 'pushed.txt')
      // A push config that would send the branch somewhere else is overridden by the explicit refspec.
      git(ws.dir, 'config', 'remote.origin.push', `refs/heads/${BRANCH}:refs/heads/main`)
      await pushBranch(ws.dir, BRANCH, 'main')
      expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(git(ws.dir, 'rev-parse', 'HEAD'))
      expect(git(origin, 'rev-parse', 'main')).not.toBe(git(ws.dir, 'rev-parse', 'HEAD'))
    } finally {
      git(ws.dir, 'config', '--unset', 'remote.origin.push')
      await ws.cleanup()
    }
  })

  it('refuses the default branch, non-runner branches, a detached HEAD and HEAD on another branch', async () => {
    const ws = await prepareWorkspace(cfgWith({ 'group/demo': { clonePath: clone } }), repo(), BRANCH)
    const before = git(origin, 'for-each-ref')
    try {
      await expect(pushBranch(ws.dir, 'main', 'main')).rejects.toMatchObject({ reason: 'default_branch' })
      await expect(pushBranch(ws.dir, 'yoda/abcd1234-x', 'yoda/abcd1234-x')).rejects.toMatchObject({ reason: 'default_branch' })
      await expect(pushBranch(ws.dir, 'feature/x', 'main')).rejects.toMatchObject({ reason: 'not_runner_branch' })
      await expect(pushBranch(ws.dir, 'yoda/abcd1234-x:main', 'main')).rejects.toMatchObject({ reason: 'not_runner_branch' })

      // The agent switched to main and committed there.
      git(ws.dir, 'checkout', '-q', '-B', 'main-local', 'origin/main')
      commitFile(ws.dir, 'sneaky.txt')
      await expect(pushBranch(ws.dir, BRANCH, 'main')).rejects.toMatchObject({ reason: 'head_not_on_branch' })

      git(ws.dir, 'checkout', '-q', '--detach')
      await expect(pushBranch(ws.dir, BRANCH, 'main')).rejects.toMatchObject({ reason: 'detached_head' })
      await expect(pushBranch(ws.dir, BRANCH, 'main')).rejects.toBeInstanceOf(PushRefused)
      expect(git(origin, 'for-each-ref')).toBe(before)
    } finally {
      await ws.cleanup()
      git(clone, 'branch', '-D', 'main-local')
    }
  })
})

describe('commitLeftovers', () => {
  it('commits uncommitted changes (new and changed files) and reports whether it did', async () => {
    const branch = 'yoda/abcd1234-leftovers'
    const ws = await prepareWorkspace(cfgWith({ 'group/demo': { clonePath: clone } }), repo(), branch)
    try {
      expect(await commitLeftovers(ws.dir, 'yoda: uncommitted changes from agent run')).toBe(false)
      expect(await hasNewCommits(ws.dir, 'origin/main')).toBe(false)
      writeFileSync(join(ws.dir, 'new.txt'), 'new\n')
      writeFileSync(join(ws.dir, 'README.md'), '# Changed\n')
      expect(await commitLeftovers(ws.dir, 'yoda: uncommitted changes from agent run')).toBe(true)
      expect(git(ws.dir, 'status', '--porcelain')).toBe('')
      expect(git(ws.dir, 'log', '-1', '--format=%s')).toBe('yoda: uncommitted changes from agent run')
      expect(git(ws.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['README.md', 'new.txt'])
      expect(git(ws.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
    } finally {
      await ws.cleanup()
    }
  })
})

describe('continuing a pushed branch', () => {
  it('bases the worktree on origin/<branch> when origin has it, so the next push fast-forwards', async () => {
    const branch = 'yoda/abcd1234-continue'
    const c = cfgWith({ 'group/demo': { clonePath: clone } })
    const first = await prepareWorkspace(c, repo(), branch)
    try {
      writeFileSync(join(first.dir, 'one.txt'), '1\n')
      await commitLeftovers(first.dir, 'one')
      await pushBranch(first.dir, branch, 'main')
    } finally {
      await first.cleanup()
    }
    const pushed = git(origin, 'rev-parse', branch)
    const second = await prepareWorkspace(c, repo(), branch)
    try {
      expect(git(second.dir, 'rev-parse', 'HEAD')).toBe(pushed)
      writeFileSync(join(second.dir, 'two.txt'), '2\n')
      await commitLeftovers(second.dir, 'two')
      await pushBranch(second.dir, branch, 'main')
      expect(git(origin, 'rev-parse', `${branch}~1`)).toBe(pushed)
    } finally {
      await second.cleanup()
    }
  })
})
