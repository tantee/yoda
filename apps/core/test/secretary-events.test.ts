import { MockLanguageModelV4 } from 'ai/test'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Me, TaskResult } from '@yoda/shared'
import { AiGateway } from '../src/ai/gateway.js'
import type { AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { events, knowledgeEntries, messages, notifications, people, projectMembers, projects, tasks, workItems } from '../src/db/schema.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { decideProposal } from '../src/proposals/service.js'
import { secretaryEvent } from '../src/secretary/events.js'
import { runWork } from '../src/work/context.js'
import { assignTask, createWorkItem, submitTask } from '../src/work/engine.js'
import { textStream } from './ai-mocks.js'
import { mockModels, resetDb, testDb, testDeps } from './helpers.js'
import { proposals } from '../src/db/schema.js'

/** Records every send, and lets `draft-task` / `secretary-chat` through only when asked (they are dropped). */
class SpyQueue extends InlineJobQueue {
  sent: { name: JobName; id: string }[] = []
  override async send(name: JobName, data: { id: string }): Promise<void> {
    this.sent.push({ name, id: data.id })
    if (name === 'draft-task' || name === 'secretary-chat') return
    await super.send(name, data)
  }
  count = (name: JobName) => this.sent.filter((j) => j.name === name).length
}

let db: Db
let deps: AppDeps
let jobs: SpyQueue
let prompts: string[]
let failing: boolean

async function person(name: string, staff = true): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name, staffOverride: staff })
    .returning()
  return { id: p!.id, username: name, displayName: name, email: null, isStaff: staff, isAdmin: false }
}

type Setup = Awaited<ReturnType<typeof setup>>
async function setup(noAi = false) {
  const pm = await person('pm')
  const dev = await person('dev')
  const qc = await person('qc')
  const nurse = await person('nurse1', false)
  const [proj] = await db.insert(projects).values({ name: 'P', autonomy: 'auto-assign', noAi, createdBy: pm.id }).returning()
  const projectId = proj!.id
  await db.insert(projectMembers).values([
    { projectId, personId: pm.id, roles: ['PM'] },
    { projectId, personId: dev.id, roles: ['DEV'] },
    { projectId, personId: qc.id, roles: ['QC'] },
  ])
  return { projectId, pm, dev, qc, nurse }
}

const run = <T>(me: Me | null, fn: Parameters<typeof runWork<T>>[2]) =>
  runWork(deps, me ? { id: me.id, kind: 'person' } : { id: null, kind: 'system' }, fn)

const create = (s: Setup, over: Record<string, unknown> = {}) =>
  run(s.pm, (ctx) =>
    createWorkItem(ctx, s.pm, s.projectId, { title: 'แก้รายงานช้า', description: 'หน้ารายงานโหลดนาน', templateKey: 'bug-fix', priority: 'normal', ...over }),
  )

async function complete(s: Setup, wi: string, key: string, me: Me, result: Partial<TaskResult> = {}) {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, wi), eq(tasks.templateTaskKey, key)))
    .orderBy(sql`attempt desc`)
    .limit(1)
  if (t!.assigneeId !== me.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, t!.id, me.id))
  await run(me, (ctx) => submitTask(ctx, me, t!.id, { text: '', attachmentIds: [], ...result }))
  const [pending] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.workItemId, wi), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
  if (pending) await run(s.pm, (ctx) => decideProposal(ctx, s.pm, pending.id, { decision: 'accept' }))
}

/** Drives a bug-fix item through every step; the last submit completes it. */
async function finish(s: Setup, wi: string, closer: Me = s.pm) {
  const approve = { decision: 'approve' as const }
  await complete(s, wi, 'accept-bug', s.pm, approve)
  await complete(s, wi, 'implement', s.dev, { text: 'แก้ query ให้ใช้ index ของคุณเดฟ' })
  await complete(s, wi, 'draft-tests', s.qc, { text: 'tests' })
  await complete(s, wi, 'review-code', s.dev, approve)
  await complete(s, wi, 'verify', s.qc, { text: 'ok' })
  await complete(s, wi, 'approve-release', s.qc, approve)
  await complete(s, wi, 'accept-delivery', closer, approve)
  await complete(s, wi, 'close-bug', s.pm, approve)
  await jobs.drain()
}

const aiMessages = async () => db.select().from(messages).orderBy(asc(messages.seq))
const summaries = () =>
  db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.sourceKind, 'ai'), eq(knowledgeEntries.type, 'document')))

beforeEach(async () => {
  db = await testDb()
  await resetDb(db)
  prompts = []
  failing = false
  const model = new MockLanguageModelV4({
    modelId: 'claude-haiku-5-5',
    doStream: async ({ prompt }) => {
      if (failing) throw new Error('upstream down')
      prompts.push(JSON.stringify(prompt))
      return { stream: textStream('สรุป: แก้รายงานช้าเรียบร้อย') }
    },
  })
  jobs = new SpyQueue({ onError: (err, name, id) => console.warn(`job ${name} ${id} failed`, err) })
  deps = await testDeps({
    jobs,
    ai: new AiGateway({ db, bus: new LiveBus(), models: mockModels({ fast: model }), config: { dailyTaskCap: 8 } }),
  })
})

afterEach(async () => {
  await jobs.drain()
})

describe('secretary event: work item done', () => {
  it('writes a draft AI summary and tells the requester with the fixed system message; no chat job', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    await finish(s, wi, s.nurse)
    expect(jobs.count('secretary-event')).toBe(1)
    expect(jobs.count('secretary-chat')).toBe(0)

    const sums = await summaries()
    expect(sums).toHaveLength(1)
    expect(sums[0]).toMatchObject({ scope: 'work_item', workItemId: wi, status: 'draft', sourceKind: 'ai', body: 'สรุป: แก้รายงานช้าเรียบร้อย' })
    // The summary is the only AI call; its prompt carries the work item's material.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('คุณเดฟ')

    const msgs = await aiMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      authorKind: 'system',
      authorId: null,
      text: '[[request.done]]',
      actions: [{ type: 'link', label: 'แก้รายงานช้า', to: `/requests/${wi}` }],
    })
    const conv = await db.execute(sql`select kind, owner_id from conversations where id = ${msgs[0]!.conversationId}`)
    expect(conv[0]).toMatchObject({ kind: 'intake', owner_id: s.nurse.id })
  })

  it('running the job twice creates one summary and one message', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    await finish(s, wi, s.nurse)
    await jobs.send('secretary-event', { id: wi })
    await jobs.send('secretary-event', { id: wi })
    await jobs.drain()
    expect(await summaries()).toHaveLength(1)
    expect(await aiMessages()).toHaveLength(1)
  })

  it('a noAi project makes no AI call: the requester gets the [[request.done]] system message', async () => {
    const s = await setup(true)
    const wi = await create(s, { requesterId: s.nurse.id })
    await finish(s, wi, s.nurse)
    expect(prompts).toHaveLength(0)
    expect(await summaries()).toHaveLength(0)
    const msgs = await aiMessages()
    expect(msgs).toMatchObject([{ authorKind: 'system', text: '[[request.done]]' }])
  })

  it('AI down for good: system marker; the retries do not duplicate it', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    failing = true
    await finish(s, wi, s.nurse)
    expect(await summaries()).toHaveLength(0)
    expect(await aiMessages()).toMatchObject([{ authorKind: 'system', text: '[[request.done]]' }])
  })

  it('the requester note never waits on the work item lock (lock order conversation → work item)', async () => {
    const s = await setup(true)
    const wi = await create(s, { requesterId: s.nurse.id })
    await finish(s, wi, s.nurse)
    await db.delete(messages)
    // Another transaction holds the work item row lock (as a secretary reply applying a staged action would,
    // after locking its conversation): posting the note must not queue behind it.
    const outcome = await db.transaction(async (tx) => {
      await tx.select({ id: workItems.id }).from(workItems).where(eq(workItems.id, wi)).for('update')
      return Promise.race([
        secretaryEvent(deps, { id: wi, attempt: 1, isFinalAttempt: true }).then(() => 'posted'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 3000)),
      ])
    })
    expect(outcome).toBe('posted')
    expect(await aiMessages()).toMatchObject([{ authorKind: 'system', text: '[[request.done]]' }])
  })

  it('no requester: summary only, no message', async () => {
    const s = await setup()
    const wi = await create(s)
    await finish(s, wi)
    expect(await summaries()).toHaveLength(1)
    expect(await aiMessages()).toHaveLength(0)
  })

  it('a re-run after success bills no second summary and posts no second message', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    await finish(s, wi, s.nurse)
    expect(prompts).toHaveLength(1)
    await jobs.send('secretary-event', { id: wi })
    await jobs.drain()
    expect(prompts).toHaveLength(1)
    expect(await aiMessages()).toHaveLength(1)
  })

  it('a cancelled item has no secretary effects', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    await db.update(workItems).set({ state: 'cancelled' }).where(eq(workItems.id, wi))
    await jobs.send('secretary-event', { id: wi })
    await jobs.drain()
    expect(prompts).toHaveLength(0)
    expect(await summaries()).toHaveLength(0)
    expect(await aiMessages()).toHaveLength(0)
  })

  it('ignores a work item that is not done', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.nurse.id })
    await jobs.send('secretary-event', { id: wi })
    await jobs.drain()
    expect(prompts).toHaveLength(0)
    expect(await aiMessages()).toHaveLength(0)
  })
})

describe('secretary sweep', () => {
  it('flags stuck work to the owner and PMs once per day, however often it runs', async () => {
    const s = await setup()
    const wi = await create(s)
    // Owner is the PM (creator): one recipient; add a second PM.
    await db.insert(projectMembers).values({ projectId: s.projectId, personId: s.dev.id, roles: ['PM'] }).onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.personId],
      set: { roles: ['DEV', 'PM'] },
    })
    await db.execute(sql`update events set created_at = now() - interval '4 days' where work_item_id = ${wi}`)
    await jobs.runScheduled('secretary-sweep')
    await jobs.runScheduled('secretary-sweep')
    const rows = await db.select().from(notifications).where(eq(notifications.kind, 'work_item_stuck'))
    expect(rows.map((r) => r.personId).sort()).toEqual([s.dev.id, s.pm.id].sort())
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
    expect(rows.every((r) => r.dedupeKey === `stuck:${wi}:${day}` && r.link === `/work-items/${wi}`)).toBe(true)
  })

  it('one failing item does not stop the sweep: the next stuck item is still flagged', async () => {
    const s = await setup()
    const a = await create(s, { title: 'A' })
    const b = await create(s, { title: 'B' })
    await db.execute(sql`update events set created_at = now() - interval '4 days'`)
    const publish = deps.bus.publish.bind(deps.bus)
    let first = true
    deps.bus.publish = (e) => {
      if (first) {
        first = false
        throw new Error('bus down')
      }
      publish(e)
    }
    await jobs.runScheduled('secretary-sweep')
    const rows = await db.select().from(notifications).where(eq(notifications.kind, 'work_item_stuck'))
    expect(rows.map((r) => r.link).sort()).toEqual([`/work-items/${a}`, `/work-items/${b}`].sort())
  })

  it('one failing orphan does not stop the next from being re-queued', async () => {
    const s = await setup()
    const a = await create(s, { title: 'A' })
    const b = await create(s, { title: 'B' })
    for (const wi of [a, b]) await complete(s, wi, 'accept-bug', s.pm, { decision: 'approve' })
    await db.execute(sql`update tasks set created_at = now() - interval '1 hour'`)
    let boom = true
    const orig = jobs.send.bind(jobs)
    jobs.send = async (name, data) => {
      if (name === 'draft-task' && boom) {
        boom = false
        throw new Error('queue down')
      }
      return orig(name, data)
    }
    jobs.sent = []
    await jobs.runScheduled('secretary-sweep')
    expect(jobs.count('draft-task')).toBe(1)
  })

  it('leaves recently active, finished and cancelled work alone', async () => {
    const s = await setup()
    await create(s)
    const old = await create(s, { title: 'เก่า' })
    await db.execute(sql`update events set created_at = now() - interval '4 days' where work_item_id = ${old}`)
    await db.update(workItems).set({ state: 'done' }).where(eq(workItems.id, old))
    await jobs.runScheduled('secretary-sweep')
    expect(await db.select().from(notifications).where(eq(notifications.kind, 'work_item_stuck'))).toHaveLength(0)
  })

  it('re-queues an orphaned AI draft once it is older than 10 minutes, but not a fresh or already-attempted one', async () => {
    const s = await setup()
    const wi = await create(s)
    await complete(s, wi, 'accept-bug', s.pm, { decision: 'approve' })
    // The dev step now holds two AI tasks: `implement` (code-change) and `draft-tests` (draft-text).
    const [ai] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workItemId, wi), eq(tasks.templateTaskKey, 'draft-tests')))
    expect(ai).toMatchObject({ executor: 'ai', state: 'open', assigneeId: null })
    // Only draft-text tasks are re-queued: backdate every task of the item, `implement` included.
    await db.execute(sql`update tasks set created_at = now() - interval '11 minutes' where id <> ${ai!.id} and work_item_id = ${wi}`)
    jobs.sent = []
    await jobs.runScheduled('secretary-sweep')
    expect(jobs.count('draft-task')).toBe(0) // fresh
    await db.execute(sql`update tasks set created_at = now() - interval '11 minutes' where id = ${ai!.id}`)
    await jobs.runScheduled('secretary-sweep')
    expect(jobs.sent.filter((j) => j.name === 'draft-task')).toEqual([{ name: 'draft-task', id: ai!.id }])
    // An ai.* event means a draft was attempted: not an orphan.
    await db.insert(events).values({ projectId: s.projectId, workItemId: wi, taskId: ai!.id, type: 'ai.failed', actorKind: 'ai' })
    jobs.sent = []
    await jobs.runScheduled('secretary-sweep')
    expect(jobs.count('draft-task')).toBe(0)
  })

  it('does not re-queue drafts of a noAi project', async () => {
    const s = await setup()
    const wi = await create(s)
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, s.projectId))
    await db.execute(sql`update tasks set created_at = now() - interval '1 hour' where work_item_id = ${wi}`)
    jobs.sent = []
    await jobs.runScheduled('secretary-sweep')
    expect(jobs.count('draft-task')).toBe(0)
  })
})
