import type { FastifyInstance } from 'fastify'
import type { Discussion, Me, TaskResult } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { discussions, events, notifications, people, projectMembers, projects, proposals, tasks, workItems } from '../src/db/schema.js'
import { createDiscussion, decideDiscussion, raiseFromTask, withdrawDiscussion } from '../src/discussions/service.js'
import type { InlineJobQueue } from '../src/jobs/queue.js'
import { decideProposal } from '../src/proposals/service.js'
import { runWork } from '../src/work/context.js'
import {
  advanceWorkItem,
  assignTask,
  cancelWorkItem,
  createWorkItem,
  reopenWorkItem,
  submitTask,
} from '../src/work/engine.js'
import { getWorkItemDetail } from '../src/work/queries.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

async function person(db: Db, name: string, isAdmin = false): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name, isAdmin, lastSeenStaff: true })
    .returning()
  return { id: p!.id, username: name, displayName: name, email: null, isStaff: true, isAdmin }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(db: Db, autonomy: 'propose' | 'auto-assign') {
  const pm = await person(db, 'pm')
  const dev = await person(db, 'dev')
  const qc = await person(db, 'qc')
  const [proj] = await db.insert(projects).values({ name: 'P', autonomy, createdBy: pm.id }).returning()
  const projectId = proj!.id
  await db.insert(projectMembers).values([
    { projectId, personId: pm.id, roles: ['PM'] },
    { projectId, personId: dev.id, roles: ['DEV'] },
    { projectId, personId: qc.id, roles: ['QC'] },
  ])
  return { projectId, pm, dev, qc }
}

let deps: AppDeps
let db: Db

const run = <T>(me: Me, fn: Parameters<typeof runWork<T>>[2]) => runWork(deps, { id: me.id, kind: 'person' }, fn)

const create = (s: Setup) =>
  run(s.pm, (ctx) =>
    createWorkItem(ctx, s.pm, s.projectId, { title: 'Bug', description: '', templateKey: 'bug-fix', priority: 'normal' }),
  )

async function item(id: string) {
  const [row] = await db.select().from(workItems).where(eq(workItems.id, id))
  return row!
}

async function latest(workItemId: string, key: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, key)))
    .orderBy(desc(tasks.attempt))
    .limit(1)
  return row!
}

async function itemEvents(id: string) {
  return db.select().from(events).where(eq(events.workItemId, id)).orderBy(asc(events.seq))
}

const advancesFrom = async (wi: string, from: string) =>
  (await itemEvents(wi)).filter((e) => e.type === 'work_item.step_advanced' && (e.payload as { from: string }).from === from)

const pendingAdvance = (wi: string) =>
  db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workItemId, wi), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))

const approve = { decision: 'approve' as const }

/** Hands the latest attempt of `key` to `me` (when needed) and submits it; never touches proposals. */
async function submitLatest(s: Setup, wi: string, key: string, me: Me, result: Partial<TaskResult> = {}) {
  const t = await latest(wi, key)
  if (t.assigneeId !== me.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, t.id, me.id))
  await run(me, (ctx) => submitTask(ctx, me, t.id, { text: '', attachmentIds: [], ...result }))
  return t.id
}

/** Moves a fresh item through intake (accepting the advance proposal in propose projects) to the dev step. */
async function toDev(s: Setup): Promise<string> {
  const wi = await create(s)
  await submitLatest(s, wi, 'accept-bug', s.pm, approve)
  const [p] = await pendingAdvance(wi)
  if (p) await run(s.pm, (ctx) => decideProposal(ctx, s.pm, p.id, { decision: 'accept' }))
  expect((await item(wi)).currentStepKey).toBe('dev')
  return wi
}

const raise = (me: Me, workItemId: string, question = 'ควรแก้ที่ฐานข้อมูลหรือที่หน้าจอ?') =>
  run(me, (ctx) =>
    createDiscussion(ctx, me, { workItemId, question, details: '', priority: 'normal', options: [], requestBrief: false }),
  )
const decide = (me: Me, id: string) => run(me, (ctx) => decideDiscussion(ctx, me, id, { decision: 'แก้ที่ฐานข้อมูล' }))
const withdraw = (me: Me, id: string) => run(me, (ctx) => withdrawDiscussion(ctx, me, id, { reason: 'ไม่จำเป็นแล้ว' }))
const detail = (s: Setup, wi: string) => getWorkItemDetail(db, s.pm, wi)

describe('discussions block and resume work items', () => {
  beforeEach(async () => {
    deps = await testDeps()
    db = deps.db
    await resetDb(db)
  })
  afterEach(async () => {
    await (deps.jobs as InlineJobQueue).drain()
  })

  it('auto-assign: an open discussion holds a finished step until it is decided, then the item advances once', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await toDev(s)
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    const d = await raise(s.dev, wi)
    // Tasks keep working while blocked; only the step advance waits.
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)

    expect((await item(wi)).currentStepKey).toBe('dev')
    expect(await advancesFrom(wi, 'dev')).toHaveLength(0)
    expect(await pendingAdvance(wi)).toHaveLength(0)
    expect(await detail(s, wi)).toMatchObject({ awaitingAdvance: false, openDiscussions: 1 })
    // A PM cannot push it through either.
    await expect(run(s.pm, (ctx) => advanceWorkItem(ctx, s.pm, wi))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })

    await decide(s.pm, d)
    expect((await item(wi)).currentStepKey).toBe('qc')
    expect(await advancesFrom(wi, 'dev')).toHaveLength(1)
    expect(await detail(s, wi)).toMatchObject({ awaitingAdvance: false, openDiscussions: 0 })
    expect(await db.select().from(tasks).where(and(eq(tasks.workItemId, wi), eq(tasks.templateTaskKey, 'verify')))).toHaveLength(1)
  })

  it('propose: the step-advance proposal appears only after the decision', async () => {
    const s = await setup(db, 'propose')
    const wi = await toDev(s)
    const d = await raise(s.dev, wi)
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)
    expect(await pendingAdvance(wi)).toHaveLength(0)
    expect(await detail(s, wi)).toMatchObject({ awaitingAdvance: false, openDiscussions: 1 })

    await decide(s.pm, d)
    const pending = await pendingAdvance(wi)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.payload).toMatchObject({ fromStep: 'dev', toStep: 'qc' })
    expect((await item(wi)).currentStepKey).toBe('dev')
  })

  it('propose: a pending advance proposal cannot be accepted while a discussion is open, and is not duplicated', async () => {
    const s = await setup(db, 'propose')
    const wi = await toDev(s)
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)
    const [p] = await pendingAdvance(wi)
    expect(p).toBeDefined()

    const d = await raise(s.dev, wi)
    await expect(run(s.pm, (ctx) => decideProposal(ctx, s.pm, p!.id, { decision: 'accept' }))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
    const [still] = await db.select().from(proposals).where(eq(proposals.id, p!.id))
    expect(still!.state).toBe('pending')

    await decide(s.pm, d)
    const after = await pendingAdvance(wi)
    expect(after.map((x) => x.id)).toEqual([p!.id])
    await run(s.pm, (ctx) => decideProposal(ctx, s.pm, p!.id, { decision: 'accept' }))
    expect((await item(wi)).currentStepKey).toBe('qc')
    expect(await advancesFrom(wi, 'dev')).toHaveLength(1)
  })

  it('stays blocked until every open discussion has ended; withdrawing also resumes', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await toDev(s)
    const d1 = await raise(s.dev, wi, 'เรื่องที่หนึ่ง')
    const d2 = await raise(s.qc, wi, 'เรื่องที่สอง')
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)
    expect(await detail(s, wi)).toMatchObject({ openDiscussions: 2 })

    await decide(s.pm, d1)
    expect((await item(wi)).currentStepKey).toBe('dev')
    expect(await detail(s, wi)).toMatchObject({ awaitingAdvance: false, openDiscussions: 1 })

    await withdraw(s.qc, d2)
    expect((await item(wi)).currentStepKey).toBe('qc')
    expect(await advancesFrom(wi, 'dev')).toHaveLength(1)
  })

  it('a decision racing the last task acceptance advances the step exactly once', async () => {
    for (let round = 0; round < 3; round++) {
      // The previous round's jobs (e.g. embedding the decision entry) must not race the truncate.
      await (deps.jobs as InlineJobQueue).drain()
      await resetDb(db)
      const s = await setup(db, 'auto-assign')
      const wi = await toDev(s)
      await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
      await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
      const d = await raise(s.dev, wi)
      const review = await latest(wi, 'review-code')
      if (review.assigneeId !== s.dev.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, review.id, s.dev.id))

      // Both transactions are open before either acts, so the decision and the submission truly overlap.
      let arrived = 0
      let release!: () => void
      const bothOpen = new Promise<void>((r) => (release = r))
      const barrier = () => {
        if (++arrived === 2) release()
        return bothOpen
      }
      await Promise.all([
        run(s.pm, async (ctx) => {
          await barrier()
          await decideDiscussion(ctx, s.pm, d, { decision: 'ตกลง' })
        }),
        run(s.dev, async (ctx) => {
          await barrier()
          await submitTask(ctx, s.dev, review.id, { text: '', attachmentIds: [], ...approve })
        }),
      ])
      expect((await item(wi)).currentStepKey).toBe('qc')
      expect(await advancesFrom(wi, 'dev')).toHaveLength(1)
      expect(await db.select().from(tasks).where(and(eq(tasks.workItemId, wi), eq(tasks.templateTaskKey, 'verify')))).toHaveLength(1)
    }
  })

  it('the final step: an open discussion keeps the item from completing; the decision completes it once', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await toDev(s)
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)
    await submitLatest(s, wi, 'verify', s.qc, { text: 'ok' })
    await submitLatest(s, wi, 'approve-release', s.qc, approve)
    expect((await item(wi)).currentStepKey).toBe('close')
    await submitLatest(s, wi, 'accept-delivery', s.pm, approve)
    const d = await raise(s.dev, wi)
    await submitLatest(s, wi, 'close-bug', s.pm, approve)

    expect(await item(wi)).toMatchObject({ state: 'active', currentStepKey: 'close' })
    expect((await itemEvents(wi)).filter((e) => e.type === 'work_item.done')).toHaveLength(0)
    expect(await detail(s, wi)).toMatchObject({ openDiscussions: 1, awaitingAdvance: false })

    await decide(s.pm, d)
    expect(await item(wi)).toMatchObject({ state: 'done', currentStepKey: null })
    expect((await itemEvents(wi)).filter((e) => e.type === 'work_item.done')).toHaveLength(1)
    expect(await advancesFrom(wi, 'close')).toHaveLength(1)
  })

  it('a pending raise_discussion proposal is superseded when the item is done or cancelled', async () => {
    const s = await setup(db, 'auto-assign')
    const pendingRaise = (wi: string) =>
      db
        .insert(proposals)
        .values({
          projectId: s.projectId,
          workItemId: wi,
          kind: 'raise_discussion',
          summary: 'ยกประเด็น',
          payload: { question: 'ควรทำอย่างไร?', details: '', priority: 'normal', options: [] },
          createdByKind: 'ai',
          onBehalfOf: s.dev.id,
        })
        .returning()
        .then((r) => r[0]!)
    const stateOf = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0]!.state

    const wi = await toDev(s)
    await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
    await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await submitLatest(s, wi, 'review-code', s.dev, approve)
    await submitLatest(s, wi, 'verify', s.qc, { text: 'ok' })
    await submitLatest(s, wi, 'approve-release', s.qc, approve)
    await submitLatest(s, wi, 'accept-delivery', s.pm, approve)
    const atDone = await pendingRaise(wi)
    await submitLatest(s, wi, 'close-bug', s.pm, approve)
    expect(await item(wi)).toMatchObject({ state: 'done' })
    expect(await stateOf(atDone.id)).toBe('superseded')
    expect((await itemEvents(wi)).filter((e) => e.type === 'proposal.superseded')).toHaveLength(1)

    const wi2 = await create(s)
    const atCancel = await pendingRaise(wi2)
    await run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi2))
    expect(await stateOf(atCancel.id)).toBe('superseded')
  })

  it('a raise racing the last task acceptance either holds the step or gets 409, never both', async () => {
    const outcomes = new Set<string>()
    for (let round = 0; round < 6; round++) {
      await (deps.jobs as InlineJobQueue).drain()
      await resetDb(db)
      const s = await setup(db, 'auto-assign')
      const wi = await toDev(s)
      await submitLatest(s, wi, 'implement', s.dev, { text: 'v1' })
      await submitLatest(s, wi, 'draft-tests', s.qc, { text: 'tests' })
      const review = await latest(wi, 'review-code')
      if (review.assigneeId !== s.dev.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, review.id, s.dev.id))

      let arrived = 0
      let release!: () => void
      const bothOpen = new Promise<void>((r) => (release = r))
      const barrier = () => {
        if (++arrived === 2) release()
        return bothOpen
      }
      const [raised, submitted] = await Promise.allSettled([
        run(s.pm, async (ctx) => {
          await barrier()
          return raiseFromTask(ctx, s.pm, review.id, { question: 'รอก่อน?', details: '', priority: 'normal', options: [], requestBrief: false })
        }),
        run(s.dev, async (ctx) => {
          await barrier()
          await submitTask(ctx, s.dev, review.id, { text: '', attachmentIds: [], ...approve })
        }),
      ])
      expect(submitted.status).toBe('fulfilled')
      const open = await db.select().from(discussions).where(eq(discussions.workItemId, wi))
      const advanced = await advancesFrom(wi, 'dev')
      if (raised.status === 'fulfilled') {
        // The raise won: the step holds.
        outcomes.add('held')
        expect(open.map((d) => d.state)).toEqual(['open'])
        expect(advanced).toHaveLength(0)
        expect((await item(wi)).currentStepKey).toBe('dev')
      } else {
        // The acceptance won: the step advanced and the raise was refused.
        outcomes.add('advanced')
        expect(raised.reason).toMatchObject({ statusCode: 409, body: { error: 'invalid_state' } })
        expect(open).toHaveLength(0)
        expect(advanced).toHaveLength(1)
        expect((await item(wi)).currentStepKey).toBe('qc')
      }
    }
    expect(outcomes.size).toBeGreaterThan(0)
  })

  it('a task discussion needs an active task on the current step', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await create(s)
    const accept = await latest(wi, 'accept-bug')
    await submitLatest(s, wi, 'accept-bug', s.pm, approve)
    const body = { question: 'ถามย้อนหลัง', details: '', priority: 'normal' as const, options: [], requestBrief: false }
    // Accepted, and its step has advanced.
    await expect(run(s.pm, (ctx) => raiseFromTask(ctx, s.pm, accept.id, body))).rejects.toMatchObject({
      statusCode: 409,
      body: { error: 'invalid_state' },
    })
    // An active task of the current step is fine.
    const impl = await latest(wi, 'implement')
    expect(await run(s.pm, (ctx) => raiseFromTask(ctx, s.pm, impl.id, body))).toEqual(expect.any(String))
    // Cancelled item: its tasks are rejected → 409.
    await run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi))
    await expect(run(s.pm, (ctx) => raiseFromTask(ctx, s.pm, impl.id, body))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('cancelling a work item withdraws its open discussions', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await toDev(s)
    const d = await raise(s.dev, wi)
    const decided = await raise(s.qc, wi, 'ตัดสินแล้ว')
    await decide(s.pm, decided)
    await run(s.pm, (ctx) => cancelWorkItem(ctx, s.pm, wi))

    const [row] = await db.select().from(discussions).where(eq(discussions.id, d))
    expect(row!.state).toBe('withdrawn')
    const [kept] = await db.select().from(discussions).where(eq(discussions.id, decided))
    expect(kept!.state).toBe('decided')
    const withdrawn = (await itemEvents(wi)).filter((e) => e.type === 'discussion.withdrawn')
    expect(withdrawn).toHaveLength(1)
    expect(withdrawn[0]).toMatchObject({ actorId: s.pm.id, reason: 'work_item_cancelled', payload: { discussionId: d } })
    // The raiser is told, like on a manual withdrawal.
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.personId, s.dev.id), eq(notifications.link, `/discussions/${d}`)))
    expect(notes.map((n) => n.dedupeKey)).toContain(`discussion:${d}:withdrawn`)
  })

  it('reopening a work item withdraws its open discussions', async () => {
    const s = await setup(db, 'auto-assign')
    const wi = await toDev(s)
    const d = await raise(s.dev, wi)
    await run(s.pm, (ctx) => reopenWorkItem(ctx, s.pm, wi, 'intake'))
    const [row] = await db.select().from(discussions).where(eq(discussions.id, d))
    expect(row!.state).toBe('withdrawn')
    const withdrawn = (await itemEvents(wi)).filter((e) => e.type === 'discussion.withdrawn')
    expect(withdrawn).toHaveLength(1)
    expect(withdrawn[0]).toMatchObject({ actorId: s.pm.id, reason: 'work_item_reopened' })
    expect(await detail(s, wi)).toMatchObject({ openDiscussions: 0 })
    // The reopened step can complete and advance again.
    await submitLatest(s, wi, 'accept-bug', s.pm, approve)
    expect((await item(wi)).currentStepKey).toBe('dev')
  })
})

describe('POST /tasks/:id/raise-discussion', () => {
  let app: FastifyInstance
  let admin: Who
  let pm: Who
  let dev: Who
  let ba: Who
  let outsider: Who
  let nurse: Who

  const call = (who: Who, url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(who), payload: payload as object | undefined })

  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    ba = await login(app, 'ba', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await (app.deps.jobs as InlineJobQueue).drain()
    await app.close()
  })

  it('the assignee or a PM raises a discussion linked to the task; other members get 403', async () => {
    const { id: p } = (await call(admin, '/projects', { name: 'โครงการ' })).json() as { id: string }
    for (const [who, roles] of [[pm, ['PM']], [dev, ['DEV']], [ba, ['BA']]] as [Who, string[]][]) {
      const res = await app.inject({ method: 'PUT', url: `/projects/${p}/members/${who.id}`, headers: auth(admin), payload: { roles } })
      expect(res.statusCode).toBe(200)
    }
    const wi = (await call(pm, `/projects/${p}/work-items`, { title: 'งาน', templateKey: 'bug-fix' })).json() as { id: string }
    const t = (await app.deps.db.select().from(tasks).where(eq(tasks.workItemId, wi.id)))[0]!
    const assign = await call(pm, `/tasks/${t.id}/assign`, { personId: dev.id })
    expect(assign.statusCode, assign.body).toBe(200)

    const body = { question: 'ต้องถามผู้ใช้ก่อนไหม?', options: [], requestBrief: false }
    const mine = await call(dev, `/tasks/${t.id}/raise-discussion`, body)
    expect(mine.statusCode, mine.body).toBe(201)
    expect(mine.json() as Discussion).toMatchObject({
      projectId: p,
      workItemId: wi.id,
      taskId: t.id,
      stepKey: t.stepKey,
      question: 'ต้องถามผู้ใช้ก่อนไหม?',
      state: 'open',
      raisedById: dev.id,
    })

    expect((await call(ba, `/tasks/${t.id}/raise-discussion`, body)).statusCode).toBe(403)
    expect((await call(outsider, `/tasks/${t.id}/raise-discussion`, body)).statusCode).toBe(404)
    expect((await call(nurse, `/tasks/${t.id}/raise-discussion`, body)).statusCode).toBe(403)

    const byPm = await call(pm, `/tasks/${t.id}/raise-discussion`, body)
    expect(byPm.statusCode, byPm.body).toBe(201)
    expect(byPm.json()).toMatchObject({ taskId: t.id, raisedById: pm.id })
    const open = await app.deps.db.select().from(discussions).where(eq(discussions.workItemId, wi.id))
    expect(open).toHaveLength(2)
  })
})
