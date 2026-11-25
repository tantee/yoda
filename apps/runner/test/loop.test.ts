import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunnerConfig } from '../src/config.js'
import type { CoreClient } from '../src/core.js'
import { fakeExecutor, type FakeRun } from '../src/executors/index.js'
import { startLoop, stopOnSignals } from '../src/loop.js'
import { availableTask, FakeCore } from './fake-core.js'
import { isolateGit, makeOrigin, tempDir, TOKEN } from './helpers.js'

const taskId = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`

let tmp: ReturnType<typeof tempDir>
let clone: string
let fake: FakeCore
let core: CoreClient
let lines: string[]

beforeEach(async () => {
  tmp = tempDir()
  isolateGit(tmp.dir)
  ;({ clone } = makeOrigin(tmp.dir))
  fake = new FakeCore()
  fake.tasks = [availableTask(taskId(1)), availableTask(taskId(2)), availableTask(taskId(3))]
  core = await fake.connect()
  lines = []
})
afterEach(async () => {
  await core.close()
  tmp.remove()
})

const cfg = (maxConcurrent = 1) =>
  RunnerConfig.parse({
    coreUrl: 'https://core.example.invalid',
    token: TOKEN,
    executor: 'fake',
    workRoot: join(tmp.dir, 'work'),
    maxConcurrent,
    repos: { 'group/demo': { clonePath: clone } },
  })

const nothing: FakeRun = () => ({ ok: true, summary: 'Checked, nothing to change.', needsHuman: false })
const deps = (maxConcurrent: number, run: FakeRun = nothing) => ({
  cfg: cfg(maxConcurrent),
  core,
  executor: fakeExecutor(run),
  log: (l: string) => void lines.push(l),
})

describe('startLoop', () => {
  it('with once: claims and works up to maxConcurrent in parallel, then returns 0', async () => {
    let running = 0
    let peak = 0
    const code = await startLoop(
      deps(2, async () => {
        peak = Math.max(peak, ++running)
        // Wait (up to 5 s) until both runs are inside their executors.
        for (let i = 0; i < 500 && peak < 2; i++) await new Promise((r) => setTimeout(r, 10))
        running--
        return { ok: true, summary: 'Done.', needsHuman: false }
      }),
      { once: true },
    )
    expect(code).toBe(0)
    expect(fake.named('list_available_tasks')).toHaveLength(1)
    expect(fake.named('claim_task').map((c) => c.args.taskId)).toEqual([taskId(1), taskId(2)])
    expect(fake.named('submit_result')).toHaveLength(2)
    expect(peak).toBe(2)
  })

  it('waits for the next poll on at_capacity, outside_hours or a pause', async () => {
    for (const reason of ['at_capacity', 'outside_hours', 'runner_paused', 'all_runners_paused']) {
      fake.calls = []
      fake.override.claim_task = () => ({ error: { code: 'invalid_state', reason } })
      expect(await startLoop(deps(2), { once: true })).toBe(0)
      expect(fake.named('claim_task')).toHaveLength(1)
    }
  })

  it('skips a task another runner claimed and takes the next', async () => {
    fake.override.claim_task = (args) => (args.taskId === taskId(1) ? { error: { code: 'invalid_state', reason: 'already_claimed' } } : undefined)
    expect(await startLoop(deps(1), { once: true })).toBe(0)
    expect(fake.named('claim_task').map((c) => c.args.taskId)).toEqual([taskId(1), taskId(2)])
    expect(fake.named('submit_result')).toHaveLength(1)
  })

  it('exits with code 2 on personal_unattended_not_allowed, logging it once', async () => {
    fake.override.claim_task = () => ({ error: { code: 'invalid_state', reason: 'personal_unattended_not_allowed' } })
    expect(await startLoop(deps(2), {})).toBe(2)
    expect(lines.filter((l) => l.includes('personal subscription'))).toHaveLength(1)
    expect(fake.named('claim_task')).toHaveLength(1)
  })

  it('exits with code 2 when core says the runner is on demand, without claiming', async () => {
    fake.override.list_available_tasks = () => ({ error: { code: 'invalid_state', reason: 'on_demand_runner' } })
    expect(await startLoop(deps(1), {})).toBe(2)
    expect(lines.filter((l) => l.includes('on demand'))).toHaveLength(1)
    expect(fake.named('list_available_tasks')).toHaveLength(1)
    expect(fake.named('claim_task')).toHaveLength(0)
  })

  it('skips a task it gave back for 10 minutes, then tries it again', async () => {
    fake.tasks = [availableTask(taskId(1))]
    let clock = 0
    const stop = new AbortController()
    let polls = 0
    const noClone = RunnerConfig.parse({ coreUrl: 'https://core.example.invalid', token: TOKEN, executor: 'fake', workRoot: join(tmp.dir, 'work') })
    const code = await startLoop(
      {
        ...deps(1),
        cfg: noClone,
        now: () => clock,
        signal: stop.signal,
        sleep: async () => {
          // Let the run finish before the next poll.
          for (let i = 0; i < 500 && [...fake.runs.values()].some((r) => r.state === 'running'); i++) await new Promise((r) => setTimeout(r, 10))
          polls++
          if (polls === 2) clock += 10 * 60_000
          if (polls === 3) stop.abort()
        },
      },
      {},
    )
    expect(code).toBe(0)
    expect(fake.named('list_available_tasks')).toHaveLength(3)
    // Poll 1 claims (and releases without a strike), poll 2 skips, poll 3 (10 min later) claims again.
    expect(fake.named('claim_task')).toHaveLength(2)
    expect(fake.named('release_task').map((c) => c.args.failed)).toEqual([false, false])
  })

  it('exits with code 3 when the executor cannot be started, without claiming more', async () => {
    const stop = new AbortController()
    const code = await startLoop(
      {
        ...deps(1, () => ({ ok: false, summary: 'claude could not be started (ENOENT)', needsHuman: false, notStarted: true })),
        signal: stop.signal,
        sleep: (ms, signal) =>
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
            setTimeout(() => (stop.abort(), resolve()), 5000)
          }),
      },
      {},
    )
    expect(code).toBe(3)
    expect(fake.named('claim_task')).toHaveLength(1)
    expect(fake.named('release_task')[0]!.args).toMatchObject({ failed: false })
    expect(lines.some((l) => l.includes('cannot work tasks until fixed'))).toBe(true)
  })

  it('polls again after pollSeconds until stopped', async () => {
    fake.tasks = []
    const stop = new AbortController()
    let polls = 0
    const code = await startLoop(
      {
        ...deps(1),
        signal: stop.signal,
        sleep: async () => {
          if (++polls === 3) stop.abort()
        },
      },
      {},
    )
    expect(code).toBe(0)
    expect(fake.named('list_available_tasks')).toHaveLength(3)
  })

  it('on SIGTERM stops polling and releases running work with failed: false (runner_stopped)', async () => {
    const proc = new EventEmitter()
    const stop = new AbortController()
    const dispose = stopOnSignals(stop, proc)
    let started!: () => void
    const isStarted = new Promise<void>((r) => (started = r))
    const loop = startLoop(
      {
        ...deps(2, (input) => {
          started()
          return new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve({ ok: false, summary: 'killed', needsHuman: false })))
        }),
        signal: stop.signal,
      },
      {},
    )
    await isStarted
    proc.emit('SIGTERM')
    expect(await loop).toBe(0)
    dispose()
    const releases = fake.named('release_task')
    expect(releases).toHaveLength(2)
    for (const r of releases) expect(r.args).toMatchObject({ failed: false, reason: 'runner_stopped' })
    expect(fake.named('list_available_tasks')).toHaveLength(1)
    expect(fake.named('submit_result')).toHaveLength(0)
    expect(proc.listenerCount('SIGTERM')).toBe(0)
  })
})
