import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunnerConfig } from '../src/config.js'
import { McpToolError, type CoreClient } from '../src/core.js'
import { fakeExecutor, type FakeRun } from '../src/executors/index.js'
import { workTask } from '../src/work.js'
import { BRANCH, FakeCore, REPO_ID } from './fake-core.js'
import { git, isolateGit, makeOrigin, tempDir, TOKEN } from './helpers.js'

const TASK_ID = '00000000-0000-4000-8000-0000000000c1'

let tmp: ReturnType<typeof tempDir>
let origin: string
let clone: string
let fake: FakeCore
let core: CoreClient
let workRoot: string

beforeEach(async () => {
  tmp = tempDir()
  isolateGit(tmp.dir)
  ;({ origin, clone } = makeOrigin(tmp.dir))
  workRoot = join(tmp.dir, 'work')
  fake = new FakeCore()
  core = await fake.connect()
})
afterEach(async () => {
  vi.useRealTimers()
  await core.close()
  tmp.remove()
})

const cfg = () =>
  RunnerConfig.parse({ coreUrl: 'https://core.example.invalid', token: TOKEN, executor: 'fake', workRoot, repos: { 'group/demo': { clonePath: clone } } })

const commitFile: FakeRun = ({ dir }) => {
  writeFileSync(join(dir, 'change.txt'), 'hello\n')
  git(dir, 'add', 'change.txt')
  git(dir, 'commit', '-q', '-m', 'feat: change')
  return { ok: true, summary: 'Added change.txt.', needsHuman: false, usage: { model: 'claude-test', inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }
}

const originBranches = () => git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')
const runDirs = () => (existsSync(workRoot) ? readdirSync(workRoot).filter((d) => d !== 'clones') : [])

describe('workTask', () => {
  it('claims, pushes the branch, opens the MR and submits with its URL; the worktree is removed', async () => {
    let seenDir = ''
    const res = await workTask(
      { cfg: cfg(), core, executor: fakeExecutor((input) => ((seenDir = input.dir), commitFile(input))) },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('submitted')
    expect(fake.named('claim_task')[0]!.args).toEqual({ taskId: TASK_ID })
    expect(originBranches()).toContain(`refs/heads/${BRANCH}`)
    expect(git(origin, 'show', `${BRANCH}:change.txt`)).toBe('hello')
    expect(git(origin, 'rev-parse', 'main')).toBe(git(clone, 'rev-parse', 'origin/main'))
    const mr = fake.named('open_merge_request')
    expect(mr).toHaveLength(1)
    expect(mr[0]!.args).toMatchObject({ repoId: REPO_ID, sourceBranch: BRANCH, title: 'Demo item' })
    const submit = fake.named('submit_result')
    expect(submit).toHaveLength(1)
    expect(submit[0]!.args.text).toContain('Added change.txt.')
    expect(submit[0]!.args.text).toContain('https://gitlab.example.invalid/group/demo/-/merge_requests/7')
    expect(submit[0]!.args.usage).toEqual({ model: 'claude-test', inputTokens: 10, outputTokens: 5, costUsd: 0.01 })
    expect(fake.named('release_task')).toHaveLength(0)
    expect(seenDir).not.toBe('')
    expect(existsSync(seenDir)).toBe(false)
    expect(runDirs()).toEqual([])
  })

  it('commits what the agent left uncommitted before pushing', async () => {
    const res = await workTask(
      { cfg: cfg(), core, executor: fakeExecutor(({ dir }) => (writeFileSync(join(dir, 'left.txt'), 'x\n'), { ok: true, summary: 'Left a file.', needsHuman: false })) },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('submitted')
    expect(git(origin, 'show', `${BRANCH}:left.txt`)).toBe('x')
  })

  it('submits without an MR when the executor changed nothing', async () => {
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(() => ({ ok: true, summary: 'Nothing to change.', needsHuman: false })) }, { taskId: TASK_ID })
    expect(res.status).toBe('submitted')
    expect(fake.named('open_merge_request')).toHaveLength(0)
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
    expect(fake.named('submit_result')[0]!.args.text).toContain('Nothing to change.')
  })

  it('skips push and MR for a non-code capability from the context pack, even with commits', async () => {
    fake.capability = 'analyze-repo'
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID })
    expect(res.status).toBe('submitted')
    expect(fake.named('open_merge_request')).toHaveLength(0)
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
  })

  it('falls back to the listed capability when the pack has none', async () => {
    fake.capability = null
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID, capability: 'run-tests' })
    expect(res.status).toBe('submitted')
    expect(fake.named('open_merge_request')).toHaveLength(0)
  })

  it('stops after ask_human: no push, no submit, no release', async () => {
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor(async (input) => {
          commitFile(input)
          await core.askHuman({ runId: '00000000-0000-4000-8000-000000000001', question: 'Which?', details: '' })
          return { ok: true, summary: 'Asked.', needsHuman: true }
        }),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('parked')
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
    expect(fake.named('submit_result')).toHaveLength(0)
    expect(fake.named('release_task')).toHaveLength(0)
    expect(runDirs()).toEqual([])
  })

  it('treats run_not_active after the run (parked without the marker) as parked: no push', async () => {
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor((input) => {
          fake.park('00000000-0000-4000-8000-000000000001')
          return commitFile(input)
        }),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('parked')
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
    expect(fake.named('open_merge_request')).toHaveLength(0)
    expect(fake.named('release_task')).toHaveLength(0)
  })

  it('treats run_not_active on submit as ended, without a release', async () => {
    fake.override.submit_result = () => ({ error: { code: 'invalid_state', reason: 'run_not_active' } })
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(() => ({ ok: true, summary: 'Done.', needsHuman: false })) }, { taskId: TASK_ID })
    expect(res.status).toBe('parked')
    expect(fake.named('release_task')).toHaveLength(0)
  })

  it('refuses the push when the agent committed on main, and releases the run as failed', async () => {
    const before = git(origin, 'rev-parse', 'main')
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor(({ dir }) => {
          git(dir, 'checkout', '-q', '--ignore-other-worktrees', 'main')
          writeFileSync(join(dir, 'evil.txt'), 'x\n')
          git(dir, 'add', 'evil.txt')
          git(dir, 'commit', '-q', '-m', 'on main')
          return { ok: true, summary: 'Committed on main.', needsHuman: false }
        }),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('failed')
    expect(git(origin, 'rev-parse', 'main')).toBe(before)
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
    const release = fake.named('release_task')
    expect(release).toHaveLength(1)
    expect(release[0]!.args).toMatchObject({ failed: true })
    expect(String(release[0]!.args.reason)).toContain('push refused')
    expect(fake.named('open_merge_request')).toHaveLength(0)
    expect(fake.named('submit_result')).toHaveLength(0)
    expect(runDirs()).toEqual([])
  })

  it('releases as failed with a short, credential-free error when the executor fails', async () => {
    const res = await workTask(
      { cfg: cfg(), core, executor: fakeExecutor(() => ({ ok: false, summary: `boom https://user:secret@host/x ${TOKEN} ${'y'.repeat(2000)}`, needsHuman: false })) },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('failed')
    const reason = String(fake.named('release_task')[0]!.args.reason)
    expect(reason.length).toBeLessThanOrEqual(500)
    expect(reason).not.toContain('secret')
    expect(reason).not.toContain(TOKEN)
    expect(fake.named('release_task')[0]!.args.failed).toBe(true)
  })

  it('releases as failed when the repo has no local clone configured', async () => {
    const res = await workTask(
      { cfg: RunnerConfig.parse({ coreUrl: 'https://core.example.invalid', token: TOKEN, workRoot }), core, executor: fakeExecutor(commitFile) },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('failed')
    expect(String(fake.named('release_task')[0]!.args.reason)).toContain('group/demo')
  })

  it('continues the branch a previous run pushed: the next run builds on origin/<branch>', async () => {
    let failMr = true
    fake.override.open_merge_request = () => (failMr ? { error: { code: 'gitlab_unavailable' } } : undefined)
    const first = await workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID })
    expect(first.status).toBe('failed')
    expect(fake.named('release_task')[0]!.args).toMatchObject({ failed: true })
    const pushed = git(origin, 'rev-parse', BRANCH)

    failMr = false
    const second = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor(({ dir }) => {
          expect(git(dir, 'show', 'HEAD:change.txt')).toBe('hello')
          writeFileSync(join(dir, 'more.txt'), 'more\n')
          git(dir, 'add', 'more.txt')
          git(dir, 'commit', '-q', '-m', 'feat: more')
          return { ok: true, summary: 'Added more.txt.', needsHuman: false }
        }),
      },
      { taskId: TASK_ID },
    )
    expect(second.status).toBe('submitted')
    expect(git(origin, 'rev-parse', `${BRANCH}~1`)).toBe(pushed)
    expect(git(origin, 'show', `${BRANCH}:more.txt`)).toBe('more')
    expect(fake.named('open_merge_request')).toHaveLength(2)
    expect(fake.named('submit_result')[0]!.args.text).toContain('merge_requests/7')
  })

  it('works the first repo and says so when several are linked', async () => {
    const second = { ...fake.code.repos[0]!, repoId: '00000000-0000-4000-8000-0000000000a2', path: 'group/other' }
    fake.code = { ...fake.code, repos: [fake.code.repos[0]!, second] }
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID })
    expect(res.status).toBe('submitted')
    expect(fake.named('open_merge_request')[0]!.args.repoId).toBe(REPO_ID)
    expect(fake.named('submit_result')[0]!.args.text).toContain('group/other')
  })

  it('works an already claimed run without claiming again', async () => {
    const { runId } = await core.claimTask({ taskId: TASK_ID })
    const res = await workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { runId, alreadyClaimed: true })
    expect(res).toMatchObject({ status: 'submitted', runId })
    expect(fake.named('claim_task')).toHaveLength(1)
  })

  it('throws the claim refusal', async () => {
    fake.override.claim_task = () => ({ error: { code: 'invalid_state', reason: 'outside_hours' } })
    await expect(workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID })).rejects.toMatchObject({
      code: 'invalid_state',
      reason: 'outside_hours',
    })
    await expect(workTask({ cfg: cfg(), core, executor: fakeExecutor(commitFile) }, { taskId: TASK_ID })).rejects.toBeInstanceOf(McpToolError)
  })

  it('sends heartbeats every 60 s during a long run', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor(async (input) => {
          await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000)
          return commitFile(input)
        }),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('submitted')
    // Three from the timer, one right after the executor (to see whether the run was parked meanwhile).
    expect(fake.named('heartbeat').length).toBe(4)
    const n = fake.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fake.calls.length).toBe(n)
  })

  it('aborts the executor when a heartbeat finds the run gone, and ends without push or release', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        executor: fakeExecutor(async (input) => {
          commitFile(input)
          fake.park('00000000-0000-4000-8000-000000000001')
          await vi.advanceTimersByTimeAsync(60_000)
          await new Promise<void>((r) => (input.signal!.aborted ? r() : input.signal!.addEventListener('abort', () => r())))
          return { ok: false, summary: 'aborted', needsHuman: false }
        }),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('parked')
    expect(fake.named('release_task')).toHaveLength(0)
    expect(originBranches()).not.toContain(`refs/heads/${BRANCH}`)
  })

  it('releases with failed: false (runner_stopped) when stopped mid-run', async () => {
    const stop = new AbortController()
    const res = await workTask(
      {
        cfg: cfg(),
        core,
        signal: stop.signal,
        executor: fakeExecutor(
          (input) =>
            new Promise((resolve) => {
              input.signal?.addEventListener('abort', () => resolve({ ok: false, summary: 'killed', needsHuman: false }))
              stop.abort()
            }),
        ),
      },
      { taskId: TASK_ID },
    )
    expect(res.status).toBe('stopped')
    expect(fake.named('release_task')[0]!.args).toMatchObject({ failed: false, reason: 'runner_stopped' })
    expect(runDirs()).toEqual([])
  })
})
