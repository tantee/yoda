import { beforeEach, describe, expect, it } from 'vitest'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Me, TaskResult } from '@yoda/shared'
import type { AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { events, people, projectMembers, projects, tasks, workItems } from '../src/db/schema.js'
import { runWork } from '../src/work/context.js'
import { createTaskAttempt } from '../src/work/tasks.js'
import {
  assignTask,
  cancelWorkItem,
  confirmTask,
  createWorkItem,
  progressWorkItem,
  startTask,
  submitTask,
  unassignMemberTasks,
} from '../src/work/engine.js'
import { resetDb, testDb, testDeps } from './helpers.js'

async function person(db: Db, name: string, isAdmin = false): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name, isAdmin })
    .returning()
  return { id: p!.id, username: name, displayName: name, email: null, isStaff: true, isAdmin }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(db: Db, autonomy: 'propose' | 'auto-assign' = 'auto-assign') {
  const pm = await person(db, 'pm')
  const dev = await person(db, 'dev')
  const qc = await person(db, 'qc')
  const outsider = await person(db, 'outsider')
  const admin = await person(db, 'admin', true)
  const [proj] = await db.insert(projects).values({ name: 'P', autonomy, createdBy: pm.id }).returning()
  const projectId = proj!.id
  await db.insert(projectMembers).values([
    { projectId, personId: pm.id, roles: ['PM'] },
    { projectId, personId: dev.id, roles: ['DEV'] },
    { projectId, personId: qc.id, roles: ['QC'] },
  ])
  return { projectId, pm, dev, qc, outsider, admin }
}

let deps: AppDeps
let db: Db

const run = <T>(me: Me | null, fn: Parameters<typeof runWork<T>>[2]) => runWork(deps, me?.id ?? null, fn)

const create = (s: Setup, me: Me = s.pm, over: Record<string, unknown> = {}) =>
  run(me, (ctx) =>
    createWorkItem(ctx, me, s.projectId, {
      title: 'Bug',
      description: '',
      templateKey: 'bug-fix',
      priority: 'normal',
      ...over,
    }),
  )

async function item(id: string) {
  const [row] = await db.select().from(workItems).where(eq(workItems.id, id))
  return row!
}

async function itemTasks(id: string) {
  return db.select().from(tasks).where(eq(tasks.workItemId, id)).orderBy(asc(tasks.createdAt))
}

async function latest(workItemId: string, key: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, key)))
    .orderBy(desc(tasks.attempt))
    .limit(1)
  return row
}

async function itemEvents(id: string) {
  return db.select().from(events).where(eq(events.workItemId, id)).orderBy(asc(events.seq))
}

const submit = (me: Me, taskId: string, result: Partial<TaskResult> = {}) =>
  run(me, (ctx) => submitTask(ctx, me, taskId, { text: '', ...result }))

/** Completes the latest attempt of `key` as `me`, handing it to `me` first when it is unassigned/AI. */
async function complete(s: Setup, wi: string, key: string, me: Me, result: Partial<TaskResult> = {}) {
  const t = (await latest(wi, key))!
  if (t.assigneeId !== me.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, t.id, me.id))
  await submit(me, t.id, result)
  return t.id
}

const approve = { decision: 'approve' as const }

describe('workflow engine', () => {
  beforeEach(async () => {
    deps = await testDeps()
    db = deps.db
    await resetDb(db)
  })

  it('creating a bug-fix item starts intake with accept-bug assigned to the PM', async () => {
    const s = await setup(db)
    const wi = await create(s)
    expect((await item(wi)).currentStepKey).toBe('intake')
    const ts = await itemTasks(wi)
    expect(ts).toHaveLength(1)
    expect(ts[0]).toMatchObject({ templateTaskKey: 'accept-bug', assigneeId: s.pm.id, state: 'open', attempt: 1 })
    const types = (await itemEvents(wi)).map((e) => e.type)
    expect(types).toContain('work_item.created')
    expect(types).toContain('task.created')
  })

  it('runs the full bug-fix happy path to done', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    expect((await item(wi)).currentStepKey).toBe('dev')
    await complete(s, wi, 'implement', s.dev, { text: 'done' })
    await complete(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await complete(s, wi, 'review-code', s.dev, approve)
    expect((await item(wi)).currentStepKey).toBe('qc')
    await complete(s, wi, 'verify', s.qc, { text: 'ok' })
    await complete(s, wi, 'approve-release', s.qc, approve)
    expect((await item(wi)).currentStepKey).toBe('close')
    await complete(s, wi, 'close-bug', s.pm, approve)

    const done = await item(wi)
    expect(done.state).toBe('done')
    expect(done.currentStepKey).toBeNull()
    const evs = await itemEvents(wi)
    expect(evs.at(-1)!.type).toBe('work_item.done')
    expect(evs.filter((e) => e.type === 'work_item.step_advanced').map((e) => e.payload)).toEqual([
      { from: 'intake', to: 'dev' },
      { from: 'dev', to: 'qc' },
      { from: 'qc', to: 'close' },
      { from: 'close', to: null },
    ])
  })

  it('creates review-code only after implement is accepted; draft-tests at step entry', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    const keys = (await itemTasks(wi)).map((t) => t.templateTaskKey)
    expect(keys).toContain('implement')
    expect(keys).toContain('draft-tests')
    expect(keys).not.toContain('review-code')
    const impl = (await latest(wi, 'implement'))!
    expect(impl).toMatchObject({ executor: 'ai', assigneeId: null, state: 'open' })

    await complete(s, wi, 'implement', s.dev, { text: 'code' })
    expect(await latest(wi, 'review-code')).toMatchObject({ attempt: 1, state: 'open', assigneeId: s.dev.id })
  })

  it('assignTask hands an ai task to a person as a takeover', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    const impl = (await latest(wi, 'implement'))!
    await expect(run(s.dev, (ctx) => assignTask(ctx, s.dev, impl.id, s.dev.id))).rejects.toMatchObject({
      statusCode: 403,
    })
    await expect(run(s.pm, (ctx) => assignTask(ctx, s.pm, impl.id, s.outsider.id))).rejects.toMatchObject({
      statusCode: 422,
      body: { error: 'not_member' },
    })
    await run(s.pm, (ctx) => assignTask(ctx, s.pm, impl.id, s.dev.id))
    expect(await latest(wi, 'implement')).toMatchObject({ executor: 'human', assigneeId: s.dev.id, state: 'open' })
    const ev = (await itemEvents(wi)).filter((e) => e.taskId === impl.id && e.type === 'task.assigned')
    expect(ev.at(-1)!.payload).toMatchObject({ takeover: true })

    await submit(s.dev, impl.id, { text: 'x' })
    await expect(run(s.pm, (ctx) => assignTask(ctx, s.pm, impl.id, s.dev.id))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
  })

  it('review changes loops back to implement with feedback, then re-reviews', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    await complete(s, wi, 'implement', s.dev, { text: 'v1' })
    await complete(s, wi, 'draft-tests', s.qc, { text: 't' })
    const review1 = (await latest(wi, 'review-code'))!
    await submit(s.dev, review1.id, { decision: 'changes', text: 'แก้ชื่อตัวแปร' })

    expect(await latest(wi, 'review-code')).toMatchObject({ id: review1.id, state: 'rejected' })
    const rejected = (await itemEvents(wi)).find((e) => e.taskId === review1.id && e.type === 'task.rejected')
    expect(rejected!.reason).toBe('แก้ชื่อตัวแปร')
    const impl2 = (await latest(wi, 'implement'))!
    expect(impl2).toMatchObject({
      attempt: 2,
      feedback: 'แก้ชื่อตัวแปร',
      assigneeId: s.dev.id,
      executor: 'human',
      state: 'open',
    })
    expect((await item(wi)).currentStepKey).toBe('dev')

    await submit(s.dev, impl2.id, { text: 'v2' })
    expect((await item(wi)).currentStepKey).toBe('dev')
    const review2 = (await latest(wi, 'review-code'))!
    expect(review2).toMatchObject({ attempt: 2, state: 'open', assigneeId: s.dev.id })
    await submit(s.dev, review2.id, approve)
    expect((await item(wi)).currentStepKey).toBe('qc')
  })

  it('request changes on an approval keeps the comment as feedback on the next attempt', async () => {
    const s = await setup(db)
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    await submit(s.pm, t.id, { decision: 'changes', text: 'ข้อมูลไม่ครบ' })
    expect(await latest(wi, 'accept-bug')).toMatchObject({
      attempt: 2,
      state: 'open',
      assigneeId: s.pm.id,
      feedback: 'ข้อมูลไม่ครบ',
    })
  })

  it('validates submissions', async () => {
    const s = await setup(db)
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    await expect(submit(s.pm, t.id, { text: 'ok' })).rejects.toMatchObject({
      statusCode: 422,
      body: { error: 'decision_required' },
    })
    await expect(submit(s.pm, t.id, { decision: 'changes', text: '   ' })).rejects.toMatchObject({
      statusCode: 422,
      body: { error: 'comment_required' },
    })
    await expect(submit(s.dev, t.id, approve)).rejects.toMatchObject({ statusCode: 403 })
    await submit(s.pm, t.id, approve)
    await expect(submit(s.pm, t.id, approve)).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
  })

  it('startTask moves open to in_progress for the assignee only', async () => {
    const s = await setup(db)
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    await expect(run(s.dev, (ctx) => startTask(ctx, s.dev, t.id))).rejects.toMatchObject({ statusCode: 403 })
    await run(s.pm, (ctx) => startTask(ctx, s.pm, t.id))
    expect((await latest(wi, 'accept-bug'))!.state).toBe('in_progress')
    await expect(run(s.pm, (ctx) => startTask(ctx, s.pm, t.id))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
    await submit(s.pm, t.id, approve)
    expect((await item(wi)).currentStepKey).toBe('dev')
  })

  it('concurrent completion advances once', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    await complete(s, wi, 'implement', s.dev, { text: 'v1' })
    const draft = (await latest(wi, 'draft-tests'))!
    await run(s.pm, (ctx) => assignTask(ctx, s.pm, draft.id, s.qc.id))
    const review = (await latest(wi, 'review-code'))!

    // Both transactions are open before either submits, so the two submissions truly overlap.
    let arrived = 0
    let release!: () => void
    const bothOpen = new Promise<void>((r) => (release = r))
    const barrier = () => {
      if (++arrived === 2) release()
      return bothOpen
    }
    const concurrently = (me: Me, taskId: string, result: TaskResult) =>
      run(me, async (ctx) => {
        await barrier()
        await submitTask(ctx, me, taskId, result)
      })
    await Promise.all([concurrently(s.dev, review.id, { text: '', ...approve }), concurrently(s.qc, draft.id, { text: 't' })])

    const advanced = (await itemEvents(wi)).filter(
      (e) => e.type === 'work_item.step_advanced' && (e.payload as { from: string }).from === 'dev',
    )
    expect(advanced).toHaveLength(1)
    expect((await itemTasks(wi)).filter((t) => t.templateTaskKey === 'verify')).toHaveLength(1)
    expect((await item(wi)).currentStepKey).toBe('qc')
  })

  it('rejects owners who are not members and unknown templates', async () => {
    const s = await setup(db)
    await expect(create(s, s.pm, { ownerId: s.outsider.id })).rejects.toMatchObject({
      statusCode: 422,
      body: { error: 'not_member' },
    })
    await expect(create(s, s.pm, { templateKey: 'nope' })).rejects.toMatchObject({
      statusCode: 404,
      body: { error: 'not_found' },
    })
    await expect(create(s, s.outsider)).rejects.toMatchObject({ statusCode: 404 })
    const wi = await create(s, s.admin, { ownerId: s.dev.id })
    expect(await item(wi)).toMatchObject({ ownerId: s.dev.id, createdBy: s.admin.id })
  })

  it('cancel rejects active tasks and stops progress', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    const active = (await itemTasks(wi)).filter((t) => t.state === 'open').map((t) => t.id)
    expect(active.length).toBeGreaterThan(0)

    await expect(run(s.qc, (ctx) => cancelWorkItem(ctx, s.qc, wi))).rejects.toMatchObject({ statusCode: 403 })
    await run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi))

    expect((await item(wi)).state).toBe('cancelled')
    const after = await itemTasks(wi)
    for (const id of active) expect(after.find((t) => t.id === id)!.state).toBe('rejected')
    const evs = await itemEvents(wi)
    expect(evs.filter((e) => e.type === 'task.rejected').every((e) => e.reason === 'work_item_cancelled')).toBe(true)
    expect(evs.at(-1)!.type).toBe('work_item.cancelled')

    await run(null, (ctx) => progressWorkItem(ctx, wi))
    await run(null, (ctx) => progressWorkItem(ctx, wi))
    expect(await itemTasks(wi)).toHaveLength(after.length)
    await expect(run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('propose projects create the first task as proposed', async () => {
    const s = await setup(db, 'propose')
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    expect(t).toMatchObject({ state: 'proposed', proposedAssigneeId: s.pm.id, assigneeId: null })

    await run(s.pm, (ctx) => assignTask(ctx, s.pm, t.id, s.pm.id))
    expect(await latest(wi, 'accept-bug')).toMatchObject({ state: 'open', assigneeId: s.pm.id, proposedAssigneeId: null })
  })
  it('startTask and submitTask require the assignee to still be a member', async () => {
    const s = await setup(db)
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, approve)
    const impl = (await latest(wi, 'implement'))!
    await run(s.pm, (ctx) => assignTask(ctx, s.pm, impl.id, s.dev.id))
    // Membership row removed without going through unassignMemberTasks.
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.personId, s.dev.id)))
    await expect(run(s.dev, (ctx) => startTask(ctx, s.dev, impl.id))).rejects.toMatchObject({ statusCode: 403 })
    await expect(submit(s.dev, impl.id, { text: 'x' })).rejects.toMatchObject({ statusCode: 403 })
    expect((await latest(wi, 'implement'))!.state).toBe('open')
  })

  it('an owner who left the project cannot cancel; the PM still can', async () => {
    const s = await setup(db)
    const wi = await create(s, s.pm, { ownerId: s.dev.id })
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.personId, s.dev.id)))
    await expect(run(s.dev, (ctx) => cancelWorkItem(ctx, s.dev, wi))).rejects.toMatchObject({ statusCode: 403 })
    await run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi))
    expect((await item(wi)).state).toBe('cancelled')
  })

  it('confirmTask moves a proposed task to its proposed assignee (PM or admin only)', async () => {
    const s = await setup(db, 'propose')
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    await expect(run(s.dev, (ctx) => confirmTask(ctx, s.dev, t.id))).rejects.toMatchObject({ statusCode: 403 })
    await run(s.admin, (ctx) => confirmTask(ctx, s.admin, t.id))
    expect(await latest(wi, 'accept-bug')).toMatchObject({ state: 'open', assigneeId: s.pm.id, proposedAssigneeId: null })
    const ev = (await itemEvents(wi)).at(-1)!
    expect(ev).toMatchObject({ type: 'task.assigned', taskId: t.id, actorId: s.admin.id })
    await expect(run(s.pm, (ctx) => confirmTask(ctx, s.pm, t.id))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
  })

  it('unassignMemberTasks clears active assignments and proposals, leaving finished tasks', async () => {
    const s = await setup(db, 'propose')
    const wi = await create(s)
    const accept = (await latest(wi, 'accept-bug'))!
    await run(s.pm, (ctx) => confirmTask(ctx, s.pm, accept.id))
    await run(s.pm, (ctx) => startTask(ctx, s.pm, accept.id))
    const other = await create(s)
    const proposed = (await latest(other, 'accept-bug'))!
    const done = await create(s)
    await complete(s, done, 'accept-bug', s.pm, approve)

    await run(s.admin, (ctx) => unassignMemberTasks(ctx, s.projectId, s.pm.id))

    expect(await latest(wi, 'accept-bug')).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
    expect(await latest(other, 'accept-bug')).toMatchObject({ id: proposed.id, state: 'open', assigneeId: null, proposedAssigneeId: null })
    expect(await latest(done, 'accept-bug')).toMatchObject({ state: 'accepted', assigneeId: s.pm.id })
    const ev = (await itemEvents(wi)).at(-1)!
    expect(ev).toMatchObject({ type: 'task.unassigned', reason: 'member_removed', actorId: s.admin.id })
  })

  it('member removal waits for an in-flight assignment on another work item', async () => {
    const s = await setup(db, 'propose')
    const wi = await create(s)
    const t = (await latest(wi, 'accept-bug'))!
    await run(s.pm, (ctx) => confirmTask(ctx, s.pm, t.id))
    // wi holds no task of dev's. A transaction locks it and proposes a DEV task to dev, then stalls.
    let release!: () => void
    const stalled = new Promise<void>((r) => (release = r))
    let proposedTo: string | null = null
    const inflight = run(s.pm, async (ctx) => {
      await ctx.tx.select().from(workItems).where(eq(workItems.id, wi)).for('update')
      const id = await createTaskAttempt(ctx, {
        workItemId: wi, projectId: s.projectId, stepKey: 'dev',
        task: { key: 'review-code', type: 'review', role: 'DEV', title: { th: 'x', en: 'x' }, instructions: { th: 'x', en: 'x' }, dependsOn: [] },
        attempt: 1, feedback: null, assigneeHint: null, executor: 'human',
      })
      const [row] = await ctx.tx.select().from(tasks).where(eq(tasks.id, id))
      proposedTo = row!.proposedAssigneeId
      await stalled
    })
    while (proposedTo === null) await new Promise((r) => setTimeout(r, 5))
    expect(proposedTo).toBe(s.dev.id)

    const removal = run(s.pm, async (ctx) => {
      await ctx.tx.delete(projectMembers).where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.personId, s.dev.id)))
      await unassignMemberTasks(ctx, s.projectId, s.dev.id)
    })
    // Wait (bounded) until the removal is blocked on a lock, then let the in-flight work commit.
    let done = false
    void removal.finally(() => (done = true))
    for (let i = 0; i < 400 && !done; i++) {
      const rows = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)
      if (rows.length > 0) break
      await new Promise((r) => setTimeout(r, 5))
    }
    release()
    await Promise.all([inflight, removal])
    expect(await latest(wi, 'review-code')).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
  })
})
