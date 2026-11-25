import type { Me, WorkingHours } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppDeps } from '../src/app.js'
import { agentRuns, aiCalls, discussions, events, people, projectMembers, projects, runners, runnerSettings, tasks, workItems } from '../src/db/schema.js'
import { claimTask, expireLeases, heartbeat, listAvailableTasks, releaseRun, requireLiveRun, type RunnerCtx } from '../src/runners/claims.js'
import { meFromPerson, revokeRunner } from '../src/runners/records.js'
import { newRunnerToken } from '../src/runners/tokens.js'
import { runWork } from '../src/work/context.js'
import { retryAiTask } from '../src/work/engine.js'
import { getTodo, getWorkItemDetail, tasksWithContext } from '../src/work/queries.js'
import { latestTemplate } from '../src/workflow/seed.js'
import { resetDb, testDb, testDeps } from './helpers.js'

type TaskRow = typeof tasks.$inferSelect

let deps: AppDeps & { now: () => Date }
let clock: Date
let owner: Me
let other: Me
let projectId: string
let itemId: string
let implement: TaskRow
let draftTests: TaskRow

// Wednesday 2026-11-25 10:00 in Asia/Bangkok (UTC+7).
const WED_10 = new Date('2026-11-25T03:00:00Z')
// Sunday 2026-11-29 10:00 in Asia/Bangkok.
const SUN_10 = new Date('2026-11-29T03:00:00Z')
const WEEKDAYS: WorkingHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }

async function person(username: string, opts: { admin?: boolean } = {}): Promise<Me> {
  const db = await testDb()
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${username}`, username, displayName: username, lastSeenStaff: true, isAdmin: opts.admin ?? false })
    .returning()
  return meFromPerson(p!)
}

async function runner(who: Me, patch: Partial<typeof runners.$inferInsert> = {}): Promise<RunnerCtx> {
  const db = await testDb()
  const { hash, prefix } = newRunnerToken()
  const [r] = await db
    .insert(runners)
    .values({
      name: `${who.username}-runner`,
      kind: 'server',
      ownerId: who.id,
      accountType: 'api-key',
      capabilities: ['code-change'],
      mode: 'unattended',
      tokenHash: hash,
      tokenPrefix: prefix,
      createdBy: who.id,
      ...patch,
    })
    .returning()
  return { runner: r!, owner: who }
}

async function addTask(values: Partial<typeof tasks.$inferInsert> & { templateTaskKey: string }): Promise<TaskRow> {
  const db = await testDb()
  const [t] = await db
    .insert(tasks)
    .values({ workItemId: itemId, projectId, stepKey: 'dev', attempt: 1, type: 'ai', role: 'DEV', executor: 'ai', state: 'open', ...values })
    .returning()
  return t!
}

const taskRow = async (id: string) => (await (await testDb()).select().from(tasks).where(eq(tasks.id, id)))[0]!
const runsOf = async (taskId: string) => (await testDb()).select().from(agentRuns).where(eq(agentRuns.taskId, taskId))
const listed = async (rc: RunnerCtx, capabilities?: RunnerCtx['runner']['capabilities']) =>
  (await listAvailableTasks(deps, rc, capabilities ? { capabilities: capabilities as never } : {})).map((t) => t.taskId)

async function refused(p: Promise<unknown>, reason: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ statusCode: 409, body: { error: 'invalid_state', reason } })
}

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  clock = WED_10
  const base = await testDeps()
  deps = { ...base, now: () => clock }
  owner = await person('dev')
  other = await person('outsider')
  const [p] = await db.insert(projects).values({ name: 'Lab' }).returning()
  projectId = p!.id
  await db.insert(projectMembers).values({ projectId, personId: owner.id, roles: ['DEV'] })
  const templateId = (await latestTemplate(db, 'bug-fix'))!.id
  const [w] = await db
    .insert(workItems)
    .values({ projectId, templateId, title: 'Fix lab report', ownerId: owner.id, currentStepKey: 'dev' })
    .returning()
  itemId = w!.id
  implement = await addTask({ templateTaskKey: 'implement' })
  draftTests = await addTask({ templateTaskKey: 'draft-tests', role: 'QC' })
})

describe('listAvailableTasks', () => {
  it('offers an open code-change AI task to a code-change runner of a project member', async () => {
    const rc = await runner(owner)
    const list = await listAvailableTasks(deps, rc, {})
    expect(list).toEqual([
      {
        taskId: implement.id,
        title: expect.objectContaining({ en: expect.any(String), th: expect.any(String) }),
        workItemId: itemId,
        workItemTitle: 'Fix lab report',
        projectName: 'Lab',
        capability: 'code-change',
        stepKey: 'dev',
        priority: 'normal',
        createdAt: implement.createdAt.toISOString(),
      },
    ])
  })

  it('never offers draft-text, other capabilities, no-AI projects or projects the owner cannot see', async () => {
    const rc = await runner(owner)
    expect(await listed(rc)).not.toContain(draftTests.id)
    expect(await listed(rc, ['analyze-repo'])).toEqual([])
    expect(await listed(await runner(owner, { capabilities: ['analyze-repo'] }))).toEqual([])
    expect(await listed(await runner(other))).toEqual([])
    const db = await testDb()
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, projectId))
    expect(await listed(rc)).toEqual([])
  })

  it('admins see every project', async () => {
    const admin = await person('boss', { admin: true })
    expect(await listed(await runner(admin))).toEqual([implement.id])
  })

  it('skips assigned, claimed, superseded, other-step and parked tasks; a decided discussion unparks', async () => {
    const db = await testDb()
    const rc = await runner(owner)
    await db.update(tasks).set({ assigneeId: owner.id }).where(eq(tasks.id, implement.id))
    expect(await listed(rc)).toEqual([])
    await db.update(tasks).set({ assigneeId: null, supersededAt: new Date() }).where(eq(tasks.id, implement.id))
    expect(await listed(rc)).toEqual([])
    await db.update(tasks).set({ supersededAt: null }).where(eq(tasks.id, implement.id))
    await db.update(workItems).set({ currentStepKey: 'qc' }).where(eq(workItems.id, itemId))
    expect(await listed(rc)).toEqual([])
    await db.update(workItems).set({ currentStepKey: 'dev' }).where(eq(workItems.id, itemId))

    const [d] = await db
      .insert(discussions)
      .values({ projectId, workItemId: itemId, taskId: implement.id, question: 'which?', raisedBy: owner.id })
      .returning()
    await db.update(tasks).set({ parkedDiscussionId: d!.id }).where(eq(tasks.id, implement.id))
    expect(await listed(rc)).toEqual([])
    await db.update(discussions).set({ state: 'decided' }).where(eq(discussions.id, d!.id))
    expect(await listed(rc)).toEqual([implement.id])

    await claimTask(deps, rc, implement.id)
    expect(await listed(rc)).toEqual([])
  })

  it('orders by priority (urgent first), then oldest', async () => {
    const db = await testDb()
    const templateId = (await latestTemplate(db, 'bug-fix'))!.id
    const [w2] = await db
      .insert(workItems)
      .values({ projectId, templateId, title: 'Urgent', ownerId: owner.id, currentStepKey: 'dev', priority: 'urgent' })
      .returning()
    const [urgent] = await db
      .insert(tasks)
      .values({ workItemId: w2!.id, projectId, stepKey: 'dev', templateTaskKey: 'implement', attempt: 1, type: 'ai', role: 'DEV', executor: 'ai', state: 'open' })
      .returning()
    expect(await listed(await runner(owner))).toEqual([urgent!.id, implement.id])
  })
})

describe('claimTask', () => {
  it('claims: the task is in progress and the run is running with a lease', async () => {
    const rc = await runner(owner)
    const { run } = await claimTask(deps, rc, implement.id)
    expect(run).toMatchObject({ taskId: implement.id, runnerId: rc.runner.id, runnerName: 'dev-runner', state: 'running' })
    expect(new Date(run.leaseExpiresAt).getTime()).toBe(WED_10.getTime() + 600_000)
    expect((await taskRow(implement.id)).state).toBe('in_progress')
    const [ev] = await (await testDb()).select().from(events).where(eq(events.type, 'run.claimed'))
    expect(ev).toMatchObject({ actorId: owner.id, actorKind: 'ai', taskId: implement.id })
    expect(ev!.payload).toMatchObject({ runId: run.id, onBehalfOf: owner.id })
  })

  it('a second claim by another runner is refused', async () => {
    await claimTask(deps, await runner(owner), implement.id)
    await refused(claimTask(deps, await runner(owner, { name: 'second' }), implement.id), 'task_unavailable')
  })

  it('two concurrent claims: exactly one wins', async () => {
    const a = await runner(owner)
    const b = await runner(owner, { name: 'b' })
    const results = await Promise.allSettled([claimTask(deps, a, implement.id), claimTask(deps, b, implement.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toMatchObject({ statusCode: 409, body: { error: 'invalid_state' } })
    expect(await runsOf(implement.id)).toHaveLength(1)
  })

  it('refuses draft-text tasks and tasks of projects the owner cannot see', async () => {
    await refused(claimTask(deps, await runner(owner), draftTests.id), 'task_unavailable')
    await expect(claimTask(deps, await runner(other), implement.id)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('safeguards', () => {
  it('global pause', async () => {
    await (await testDb()).update(runnerSettings).set({ paused: true })
    await refused(claimTask(deps, await runner(owner), implement.id), 'all_runners_paused')
  })

  it('runner pause, read from the runner row at claim time', async () => {
    const rc = await runner(owner)
    await (await testDb()).update(runners).set({ paused: true }).where(eq(runners.id, rc.runner.id))
    await refused(claimTask(deps, rc, implement.id), 'runner_paused')
  })

  it('outside working hours (Asia/Bangkok) for unattended claims', async () => {
    const rc = await runner(owner, { workingHours: WEEKDAYS })
    clock = SUN_10
    await refused(claimTask(deps, rc, implement.id), 'outside_hours')
    clock = new Date('2026-11-25T10:30:00Z') // Wednesday 17:30 in Bangkok
    await refused(claimTask(deps, rc, implement.id), 'outside_hours')
    clock = WED_10
    await claimTask(deps, rc, implement.id)
  })

  it('at capacity', async () => {
    const rc = await runner(owner, { maxConcurrent: 1 })
    const [w] = await (await testDb())
      .insert(tasks)
      .values({ workItemId: itemId, projectId, stepKey: 'dev', templateTaskKey: 'review-code', attempt: 1, type: 'human', role: 'DEV', executor: 'human', state: 'open', assigneeId: owner.id })
      .returning()
    await claimTask(deps, rc, w!.id)
    await refused(claimTask(deps, rc, implement.id), 'at_capacity')
  })

  it('personal subscription unattended: refused until the admin allows it', async () => {
    const rc = await runner(owner, { accountType: 'personal-subscription' })
    await refused(claimTask(deps, rc, implement.id), 'personal_unattended_not_allowed')
    await (await testDb()).update(runnerSettings).set({ allowPersonalUnattended: true })
    await claimTask(deps, rc, implement.id)
  })

  it('no-AI project', async () => {
    const db = await testDb()
    const rc = await runner(owner)
    const own = await addTask({ templateTaskKey: 'review-code', type: 'human', executor: 'human', assigneeId: owner.id })
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, projectId))
    await refused(claimTask(deps, rc, own.id), 'no_ai')
  })

  it('budget used up', async () => {
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '1.00' }).where(eq(projects.id, projectId))
    await db.insert(aiCalls).values({ projectId, job: 'draft', ok: true, costUsd: '1.500000' })
    await refused(claimTask(deps, await runner(owner), implement.id), 'budget_exceeded')
  })

  it('on demand: the owner claims their own assigned human task outside working hours', async () => {
    const rc = await runner(owner, { workingHours: WEEKDAYS })
    const own = await addTask({ templateTaskKey: 'review-code', type: 'human', executor: 'human', assigneeId: owner.id })
    clock = SUN_10
    const { run } = await claimTask(deps, rc, own.id)
    expect(run.state).toBe('running')
    expect((await taskRow(own.id)).state).toBe('in_progress')
  })
})

describe('leases', () => {
  it('heartbeat extends the lease', async () => {
    const rc = await runner(owner)
    const { run } = await claimTask(deps, rc, implement.id)
    clock = new Date(WED_10.getTime() + 300_000)
    const { leaseExpiresAt } = await heartbeat(deps, rc, run.id)
    expect(new Date(leaseExpiresAt).getTime()).toBe(clock.getTime() + 600_000)
  })

  it('expireLeases: an expired run reopens its AI task; the stale heartbeat is refused', async () => {
    const rc = await runner(owner)
    const { run } = await claimTask(deps, rc, implement.id)
    clock = new Date(WED_10.getTime() + 601_000)
    // Before the sweep, the lapsed lease already refuses calls on the run.
    await refused(heartbeat(deps, rc, run.id), 'run_not_active')
    await expireLeases(deps)
    const [r] = await runsOf(implement.id)
    expect(r).toMatchObject({ state: 'expired' })
    expect(r!.endedAt).not.toBeNull()
    expect((await taskRow(implement.id)).state).toBe('open')
    expect(await listed(rc)).toEqual([implement.id])
    await refused(heartbeat(deps, rc, run.id), 'run_not_active')
    expect(await (await testDb()).select().from(events).where(eq(events.type, 'run.expired'))).toHaveLength(1)
  })

  it('expireLeases leaves a live run and a person’s task with that person', async () => {
    const rc = await runner(owner, { maxConcurrent: 2 })
    const own = await addTask({ templateTaskKey: 'review-code', type: 'human', executor: 'human', assigneeId: owner.id })
    const { run } = await claimTask(deps, rc, own.id)
    await expireLeases(deps)
    expect((await runsOf(own.id))[0]!.state).toBe('running')
    clock = new Date(WED_10.getTime() + 601_000)
    await expireLeases(deps)
    expect((await runsOf(own.id))[0]!.state).toBe('expired')
    expect(await taskRow(own.id)).toMatchObject({ state: 'in_progress', assigneeId: owner.id })
    await refused(requireLiveRun((await testDb()) as never, rc, run.id), 'run_not_active')
  })

  it('a heartbeat from another runner is refused', async () => {
    const { run } = await claimTask(deps, await runner(owner), implement.id)
    await refused(heartbeat(deps, await runner(owner, { name: 'x' }), run.id), 'run_not_active')
  })
})

describe('releaseRun and the 3-strike rule', () => {
  it('release without failure reopens the task and is not a strike', async () => {
    const rc = await runner(owner)
    for (let i = 0; i < 3; i++) {
      const { run } = await claimTask(deps, rc, implement.id)
      await releaseRun(deps, rc, { runId: run.id, reason: 'shutting down', failed: false })
    }
    expect((await runsOf(implement.id)).map((r) => r.state)).toEqual(['released', 'released', 'released'])
    expect((await taskRow(implement.id)).state).toBe('open')
    expect(await listed(rc)).toEqual([implement.id])
    expect(await (await testDb()).select().from(events).where(eq(events.type, 'ai.failed'))).toHaveLength(0)
  })

  it('three failed or expired runs hand the task back to people', async () => {
    const db = await testDb()
    const rc = await runner(owner)
    const first = await claimTask(deps, rc, implement.id)
    await releaseRun(deps, rc, { runId: first.run.id, reason: 'tests fail', failed: true })
    expect(await listed(rc)).toEqual([implement.id])
    await claimTask(deps, rc, implement.id)
    clock = new Date(clock.getTime() + 601_000)
    await expireLeases(deps)
    expect(await listed(rc)).toEqual([implement.id])
    const third = await claimTask(deps, rc, implement.id)
    await releaseRun(deps, rc, { runId: third.run.id, reason: 'gave up', failed: true })

    expect((await runsOf(implement.id)).map((r) => r.state).sort()).toEqual(['expired', 'failed', 'failed'])
    const [failed] = await db.select().from(events).where(and(eq(events.type, 'ai.failed'), eq(events.taskId, implement.id)))
    expect(failed!.reason).toBe('runner_failed')
    expect(await taskRow(implement.id)).toMatchObject({ state: 'open', assigneeId: null })
    expect(await listed(rc)).toEqual([])
    // Offered to people: the PM sees it, and the work item shows that the AI could not finish it.
    const detail = await getWorkItemDetail(db, owner, itemId)
    expect(detail.tasks.find((t) => t.id === implement.id)).toMatchObject({ aiStatus: 'failed', aiFailReason: 'runner_failed' })
    const admin = await person('boss', { admin: true })
    expect((await getTodo(db, admin)).confirmations.map((t) => t.id)).toContain(implement.id)

    // A PM retry offers it to runners again, with fresh strikes.
    await runWork(deps, { id: admin.id, kind: 'person' }, (ctx) => retryAiTask(ctx, admin, implement.id))
    expect(await listed(rc)).toEqual([implement.id])
    const fourth = await claimTask(deps, rc, implement.id)
    await releaseRun(deps, rc, { runId: fourth.run.id, reason: 'again', failed: true })
    expect(await listed(rc)).toEqual([implement.id])
  })

  it('counts strikes per task row, not across attempts', async () => {
    const db = await testDb()
    const rc = await runner(owner)
    for (let i = 0; i < 2; i++) {
      const { run } = await claimTask(deps, rc, implement.id)
      await releaseRun(deps, rc, { runId: run.id, reason: 'x', failed: true })
    }
    await db.update(tasks).set({ state: 'rejected' }).where(eq(tasks.id, implement.id))
    const attempt2 = await addTask({ templateTaskKey: 'implement', attempt: 2 })
    const { run } = await claimTask(deps, rc, attempt2.id)
    await releaseRun(deps, rc, { runId: run.id, reason: 'x', failed: true })
    expect(await db.select().from(events).where(eq(events.type, 'ai.failed'))).toHaveLength(0)
    expect(await listed(rc)).toEqual([attempt2.id])
  })

  it('refuses to release a run that is not live', async () => {
    const rc = await runner(owner)
    const { run } = await claimTask(deps, rc, implement.id)
    await releaseRun(deps, rc, { runId: run.id, reason: 'done', failed: false })
    await refused(releaseRun(deps, rc, { runId: run.id, reason: 'again', failed: false }), 'run_not_active')
  })
})

describe('revoke vs claim', () => {
  it('a runner revoked after authenticating cannot claim', async () => {
    const rc = await runner(owner)
    await revokeRunner(deps, owner, rc.runner.id)
    await refused(claimTask(deps, rc, implement.id), 'runner_revoked')
    expect(await runsOf(implement.id)).toHaveLength(0)
  })

  it('runs claimed before the revoke are released', async () => {
    const rc = await runner(owner)
    await claimTask(deps, rc, implement.id)
    await revokeRunner(deps, owner, rc.runner.id)
    expect((await runsOf(implement.id))[0]!.state).toBe('released')
    expect((await taskRow(implement.id)).state).toBe('open')
  })

  it('claim racing a revoke never leaves a running run behind', async () => {
    for (let i = 0; i < 5; i++) {
      const db = await testDb()
      await db.delete(agentRuns)
      await db.update(tasks).set({ state: 'open' }).where(eq(tasks.id, implement.id))
      const rc = await runner(owner, { name: `r${i}` })
      const order = i % 2 === 0
        ? [claimTask(deps, rc, implement.id), revokeRunner(deps, owner, rc.runner.id)]
        : [revokeRunner(deps, owner, rc.runner.id), claimTask(deps, rc, implement.id)]
      const results = await Promise.allSettled(order)
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ body: { error: 'invalid_state', reason: 'runner_revoked' } })
      }
      expect((await runsOf(implement.id)).filter((r) => r.state === 'running')).toHaveLength(0)
      expect((await taskRow(implement.id)).state).toBe('open')
    }
  })
})

describe('task view', () => {
  it('staff see the latest run on the work item; task lists carry no run', async () => {
    const db = await testDb()
    const rc = await runner(owner)
    await claimTask(deps, rc, implement.id)
    const detail = await getWorkItemDetail(db, owner, itemId)
    const t = detail.tasks.find((x) => x.id === implement.id)!
    expect(t.run).toMatchObject({ state: 'running', runnerName: 'dev-runner', branch: null })
    expect(typeof t.run!.heartbeatAt).toBe('string')
    expect(detail.tasks.find((x) => x.id === draftTests.id)!.run).toBeNull()
    const [withContext] = await tasksWithContext(db, eq(tasks.id, implement.id), [], owner)
    expect(withContext).not.toHaveProperty('run')
  })
})
