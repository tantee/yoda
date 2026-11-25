import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Me, TaskResult } from '@yoda/shared'
import type { AppDeps } from '../src/app.js'
import { runDraft } from '../src/ai/drafter.js'
import { AiGateway } from '../src/ai/gateway.js'
import type { Db } from '../src/db/client.js'
import { aiCalls, events, notifications, people, projectMembers, projects, proposals, tasks, workItems } from '../src/db/schema.js'
import { decideProposal } from '../src/proposals/service.js'
import { LiveBus } from '../src/live/bus.js'
import { runWork } from '../src/work/context.js'
import { checkAdvanceGuards, reworkCount } from '../src/work/guards.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import {
  assignTask,
  confirmTask,
  createWorkItem,
  reopenWorkItem,
  submitTask,
} from '../src/work/engine.js'
import { textModel } from './ai-mocks.js'
import { mockModels, resetDb, testDb, testDeps } from './helpers.js'

async function person(db: Db, name: string, isAdmin = false): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name, isAdmin })
    .returning()
  return { id: p!.id, username: name, displayName: name, email: null, isStaff: true, isAdmin }
}

type Setup = Awaited<ReturnType<typeof setup>>

const ALL_ROLES: Record<string, string[]> = { pm: ['PM'], dev: ['DEV'], qc: ['QC'], ba: ['BA'], sa: ['SA'] }

async function setup(
  autonomy: 'propose' | 'auto-assign' = 'auto-assign',
  opts: { roles?: Record<string, string[]>; budget?: string } = {},
) {
  const roles = opts.roles ?? ALL_ROLES
  const pm = await person(db, 'pm')
  const dev = await person(db, 'dev')
  const qc = await person(db, 'qc')
  const ba = await person(db, 'ba')
  const sa = await person(db, 'sa')
  const requester = await person(db, 'requester')
  const [proj] = await db
    .insert(projects)
    .values({ name: 'P', autonomy, createdBy: pm.id, aiBudgetUsd: opts.budget ?? null })
    .returning()
  const projectId = proj!.id
  const who: Record<string, Me> = { pm, dev, qc, ba, sa }
  const rows = Object.entries(roles).map(([k, r]) => ({ projectId, personId: who[k]!.id, roles: r }))
  if (rows.length) await db.insert(projectMembers).values(rows)
  return { projectId, pm, dev, qc, ba, sa, requester }
}

let deps: AppDeps
let db: Db

const run = <T>(me: Me | null, fn: Parameters<typeof runWork<T>>[2]) =>
  runWork(deps, me ? { id: me.id, kind: 'person' } : { id: null, kind: 'system' }, fn)

const create = (s: Setup, over: Record<string, unknown> = {}) =>
  run(s.pm, (ctx) =>
    createWorkItem(ctx, s.pm, s.projectId, {
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

async function latest(workItemId: string, key: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, key)))
    .orderBy(desc(tasks.attempt))
    .limit(1)
  return row!
}

async function pendingAdvance(workItemId: string) {
  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workItemId, workItemId), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
  return p
}

async function itemEvents(id: string) {
  return db.select().from(events).where(eq(events.workItemId, id)).orderBy(asc(events.seq))
}

const submit = (me: Me, taskId: string, result: Partial<TaskResult> = {}) =>
  run(me, (ctx) => submitTask(ctx, me, taskId, { text: '', attachmentIds: [], ...result }))

/** Completes the latest attempt of `key` as `me` (handing it over first when needed). Never decides proposals. */
async function finish(s: Setup, wi: string, key: string, me: Me, result: Partial<TaskResult> = {}) {
  const t = await latest(wi, key)
  if (t.state === 'proposed' && t.proposedAssigneeId === me.id) await run(s.pm, (ctx) => confirmTask(ctx, s.pm, t.id))
  else if (t.assigneeId !== me.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, t.id, me.id))
  await submit(me, t.id, result)
  return t.id
}

const approve = { decision: 'approve' as const }
const changes = { decision: 'changes' as const, text: 'แก้ไขด้วย' }

async function acceptAdvance(s: Setup, wi: string) {
  const p = await pendingAdvance(wi)
  expect(p).toBeDefined()
  await run(s.pm, (ctx) => decideProposal(ctx, s.pm, p!.id, { decision: 'accept' }))
}

/** Through intake and the dev step without rework (implement taken over by the dev). */
async function toQc(s: Setup, wi: string) {
  await finish(s, wi, 'accept-bug', s.pm, approve)
  await finish(s, wi, 'implement', s.dev, { text: 'code' })
  await finish(s, wi, 'draft-tests', s.qc, { text: 'tests' })
  await finish(s, wi, 'review-code', s.dev, approve)
}

describe('auto-assign guard rails', () => {
  beforeEach(async () => {
    deps = await testDeps()
    db = deps.db
    await resetDb(db)
  })
  afterEach(async () => {
    await (deps.jobs as InlineJobQueue).drain()
  })

  it('a clean item advances automatically through every step', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.requester.id })
    await toQc(s, wi)
    expect((await item(wi)).currentStepKey).toBe('qc')
    await finish(s, wi, 'verify', s.qc, { text: 'ok' })
    await finish(s, wi, 'approve-release', s.qc, approve)
    expect((await item(wi)).currentStepKey).toBe('close')
    await finish(s, wi, 'accept-delivery', s.requester, approve)
    await finish(s, wi, 'close-bug', s.pm, approve)
    expect((await item(wi)).state).toBe('done')
    expect(await db.select().from(proposals)).toHaveLength(0)
  })

  it('G1: a change request in the step → step_advance proposal with guard rework', async () => {
    const s = await setup()
    const wi = await create(s)
    await finish(s, wi, 'accept-bug', s.pm, approve)
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    await finish(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await finish(s, wi, 'review-code', s.dev, changes)
    await finish(s, wi, 'implement', s.dev, { text: 'code v2' })
    await finish(s, wi, 'review-code', s.dev, approve)
    expect((await item(wi)).currentStepKey).toBe('dev')
    const p = await pendingAdvance(wi)
    expect(p).toMatchObject({ payload: { fromStep: 'dev', toStep: 'qc', guard: 'rework' } })
    expect(p!.reason).not.toBe('')
    expect((await itemEvents(wi)).some((e) => e.type === 'work_item.step_advanced' && (e.payload as { from: string }).from === 'dev')).toBe(false)
    // The PM is told why.
    const [n] = await db.select().from(notifications).where(and(eq(notifications.personId, s.pm.id), eq(notifications.kind, 'proposal_pending')))
    expect(n!.body).toContain(p!.reason)
    // The timeline's proposal.created event carries the guard.
    const created = (await itemEvents(wi)).find((e) => e.type === 'proposal.created')
    expect(created!.payload).toMatchObject({ guard: 'rework' })
    await acceptAdvance(s, wi)
    expect((await item(wi)).currentStepKey).toBe('qc')
  })

  it('G2: two change requests → the next attempts are proposed, and the advance has guard repeated_rework', async () => {
    const s = await setup()
    const wi = await create(s)
    await finish(s, wi, 'accept-bug', s.pm, approve)
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    await finish(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await finish(s, wi, 'review-code', s.dev, changes)
    // One rejection: the next attempt is still assigned automatically.
    expect(await latest(wi, 'implement')).toMatchObject({ attempt: 2, state: 'open', assigneeId: s.dev.id })
    await finish(s, wi, 'implement', s.dev, { text: 'code v2' })
    await finish(s, wi, 'review-code', s.dev, changes)
    const impl = await latest(wi, 'implement')
    expect(impl).toMatchObject({ attempt: 3, state: 'proposed', assigneeId: null, proposedAssigneeId: s.dev.id })
    const ev = (await itemEvents(wi)).filter((e) => e.taskId === impl.id)
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.proposed'])
    expect(ev.map((e) => e.reason)).toEqual(['repeated_rework', 'repeated_rework'])
    await finish(s, wi, 'implement', s.dev, { text: 'code v3' })
    // The review itself was sent back twice: its next attempt is proposed too.
    expect(await latest(wi, 'review-code')).toMatchObject({ attempt: 3, state: 'proposed', proposedAssigneeId: s.dev.id })
    await finish(s, wi, 'review-code', s.dev, approve)
    expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'repeated_rework' } })
    expect((await item(wi)).currentStepKey).toBe('dev')
  })

  it('G3: a low-confidence AI draft → proposal listing what was missing; a draft without the meta line → no guard', async () => {
    const meta = '<!--meta {"confidence":"low","missing":["ขนาดไฟล์"]}-->'
    for (const [text, guarded] of [[`# แผนทดสอบ\n\n- ทดสอบ\n\n${meta}`, true], ['# แผนทดสอบ\n\n- ทดสอบ', false]] as const) {
      await resetDb(db)
      deps = await testDeps({
        ai: new AiGateway({ db, bus: new LiveBus(), models: mockModels({ draft: textModel('claude-opus-5-5', text) }), config: deps.config }),
      })
      const s = await setup()
      const wi = await create(s)
      await finish(s, wi, 'accept-bug', s.pm, approve)
      const draft = await latest(wi, 'draft-tests')
      await runDraft(deps, draft.id)
      const drafted = await latest(wi, 'draft-tests')
      expect(drafted.state).toBe('accepted')
      const result = drafted.result as TaskResult
      // The note is stripped from what is stored and shown.
      expect(result.text).toBe('# แผนทดสอบ\n\n- ทดสอบ')
      expect(result.confidence).toBe(guarded ? 'low' : 'high')
      expect(result.missing ?? []).toEqual(guarded ? ['ขนาดไฟล์'] : [])
      await finish(s, wi, 'implement', s.dev, { text: 'code' })
      await finish(s, wi, 'review-code', s.dev, approve)
      if (guarded) {
        expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'ai_low_confidence', guardDetail: 'ขนาดไฟล์' } })
        expect((await item(wi)).currentStepKey).toBe('dev')
      } else {
        expect(await pendingAdvance(wi)).toBeUndefined()
        expect((await item(wi)).currentStepKey).toBe('qc')
      }
      await (deps.jobs as InlineJobQueue).drain()
    }
  })

  it('G4: an urgent item → advance proposed, but its tasks are still auto-assigned', async () => {
    const s = await setup()
    const wi = await create(s, { priority: 'urgent' })
    expect(await latest(wi, 'accept-bug')).toMatchObject({ state: 'open', assigneeId: s.pm.id })
    await finish(s, wi, 'accept-bug', s.pm, approve)
    expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'high_priority', fromStep: 'intake', toStep: 'dev' } })
    await acceptAdvance(s, wi)
    expect(await latest(wi, 'review-code').catch(() => undefined)).toBeUndefined()
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    expect(await latest(wi, 'review-code')).toMatchObject({ state: 'open', assigneeId: s.dev.id })
  })

  it('G5: AI budget at 80% and AI tasks next → proposal; below → automatic', async () => {
    for (const [spent, guarded] of [['0.850000', true], ['0.500000', false]] as const) {
      await resetDb(db)
      const s = await setup('auto-assign', { budget: '1.00' })
      await db.insert(aiCalls).values({ projectId: s.projectId, job: 'draft', ok: true, costUsd: spent })
      const wi = await create(s)
      await finish(s, wi, 'accept-bug', s.pm, approve)
      if (guarded) {
        expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'ai_budget' } })
        expect((await item(wi)).currentStepKey).toBe('intake')
      } else {
        expect(await pendingAdvance(wi)).toBeUndefined()
        expect((await item(wi)).currentStepKey).toBe('dev')
      }
    }
  })

  it('G5: noAi projects spend nothing on AI, so the budget guard never trips', async () => {
    const s = await setup('auto-assign', { budget: '1.00' })
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, s.projectId))
    await db.insert(aiCalls).values({ projectId: s.projectId, job: 'draft', ok: true, costUsd: '0.950000' })
    const wi = await create(s)
    await finish(s, wi, 'accept-bug', s.pm, approve)
    expect(await pendingAdvance(wi)).toBeUndefined()
    expect((await item(wi)).currentStepKey).toBe('dev')
  })

  it('G2 counts per task the same way at step advance and at assignment', async () => {
    const s = await setup()
    const wi = await create(s)
    // A task with two dependent reviews, each asking for changes once: the task was sent back twice.
    const step = {
      key: 'dev',
      name: { th: 'd', en: 'd' },
      tasks: [
        { key: 'build', type: 'human', role: 'DEV', title: { th: 'b', en: 'b' }, instructions: { th: 'x', en: 'x' }, dependsOn: [] },
        { key: 'review-a', type: 'review', role: 'DEV', title: { th: 'a', en: 'a' }, instructions: { th: 'x', en: 'x' }, dependsOn: ['build'] },
        { key: 'review-b', type: 'review', role: 'DEV', title: { th: 'b', en: 'b' }, instructions: { th: 'x', en: 'x' }, dependsOn: ['build'] },
      ],
    } as const
    const base = { workItemId: wi, projectId: s.projectId, stepKey: 'dev', attempt: 1, type: 'review', role: 'DEV', executor: 'human' } as const
    const rejection = { state: 'rejected' as const, result: { text: 'x', decision: 'changes' as const, attachmentIds: [] } }
    await db.insert(tasks).values([
      { ...base, templateTaskKey: 'review-a', ...rejection },
      { ...base, templateTaskKey: 'review-b', ...rejection },
    ])
    const [row] = await db.select().from(workItems).where(eq(workItems.id, wi))
    const stepDef = step as unknown as Parameters<typeof checkAdvanceGuards>[2]
    const verdict = await db.transaction(async (tx) => ({
      count: await reworkCount(tx, wi, stepDef, 'build'),
      guard: await checkAdvanceGuards(tx, row!, stepDef, stepDef),
    }))
    expect(verdict.count).toBe(2)
    expect(verdict.guard).toEqual({ reason: 'repeated_rework' })
  })

  it('G6: everyone at the daily cap → the task is proposed to the least-loaded person with reason daily_cap', async () => {
    deps = { ...deps, config: { ...deps.config, dailyTaskCap: 1 } }
    const s = await setup('auto-assign', { roles: { pm: ['PM'], dev: ['PM', 'DEV'], qc: ['QC'] } })
    const first = await create(s)
    const second = await create(s)
    // Each PM got one automatic assignment today (ties go by display name: dev first).
    expect((await latest(first, 'accept-bug')).assigneeId).toBe(s.dev.id)
    expect((await latest(second, 'accept-bug')).assigneeId).toBe(s.pm.id)
    // pm finishes theirs, so pm now holds less open work than dev.
    await finish(s, second, 'accept-bug', s.pm, approve)
    const third = await create(s)
    const t = await latest(third, 'accept-bug')
    expect(t).toMatchObject({ state: 'proposed', assigneeId: null, proposedAssigneeId: s.pm.id })
    const ev = (await itemEvents(third)).filter((e) => e.taskId === t.id)
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.proposed'])
    expect(ev.map((e) => e.reason)).toEqual(['daily_cap', 'daily_cap'])
  })

  it('G7: next step has a QC task and no QC member → proposal no_assignee', async () => {
    const s = await setup('auto-assign', { roles: { pm: ['PM'], dev: ['DEV'] } })
    const wi = await create(s)
    await finish(s, wi, 'accept-bug', s.pm, approve)
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    await finish(s, wi, 'draft-tests', s.dev, { text: 'tests' })
    await finish(s, wi, 'review-code', s.dev, approve)
    expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'no_assignee', guardDetail: 'QC', toStep: 'qc' } })
    expect((await item(wi)).currentStepKey).toBe('dev')
  })

  it('G8: requester changes on delivery → no automatic close; after a reopen the guard resets', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.requester.id })
    await toQc(s, wi)
    await finish(s, wi, 'verify', s.qc, { text: 'ok' })
    await finish(s, wi, 'approve-release', s.qc, approve)
    await finish(s, wi, 'accept-delivery', s.requester, changes)
    expect(await item(wi)).toMatchObject({ state: 'active', currentStepKey: 'close' })
    expect((await itemEvents(wi)).some((e) => e.type === 'work_item.done')).toBe(false)

    await run(s.pm, (ctx) => reopenWorkItem(ctx, s.pm, wi, 'qc'))
    await finish(s, wi, 'verify', s.qc, { text: 'ok again' })
    await finish(s, wi, 'approve-release', s.qc, approve)
    // Reset by the reopen: the advance to close is automatic again.
    expect(await pendingAdvance(wi)).toBeUndefined()
    expect((await item(wi)).currentStepKey).toBe('close')
    await finish(s, wi, 'accept-delivery', s.requester, approve)
    await finish(s, wi, 'close-bug', s.pm, approve)
    expect((await item(wi)).state).toBe('done')
  })

  it('G8 trips before the other guards while a requester change request stands', async () => {
    const s = await setup()
    const wi = await create(s, { requesterId: s.requester.id, priority: 'urgent' })
    await finish(s, wi, 'accept-bug', s.pm, approve)
    // A requester change request recorded on this item (e.g. on an earlier delivery) without a reopen since.
    const [t] = await db
      .insert(tasks)
      .values({
        workItemId: wi, projectId: s.projectId, stepKey: 'close', templateTaskKey: 'accept-delivery', attempt: 1,
        type: 'approval', role: 'REQUESTER', executor: 'human', state: 'rejected', assigneeId: s.requester.id,
        result: { text: 'no', decision: 'changes', attachmentIds: [] },
      })
      .returning()
    await db.insert(events).values({ projectId: s.projectId, workItemId: wi, taskId: t!.id, type: 'task.rejected', actorKind: 'person', reason: 'no' })
    await acceptAdvance(s, wi)
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    await finish(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await finish(s, wi, 'review-code', s.dev, approve)
    expect(await pendingAdvance(wi)).toMatchObject({ payload: { guard: 'requester_changes' } })
  })

  it('propose projects are unaffected: proposals carry no guard, capped people are still proposed as before', async () => {
    const s = await setup('propose')
    const wi = await create(s, { priority: 'urgent' })
    await finish(s, wi, 'accept-bug', s.pm, approve)
    const p = await pendingAdvance(wi)
    expect(p!.payload).toEqual({ fromStep: 'intake', toStep: 'dev' })
    expect(p!.reason).toBe('')
    await acceptAdvance(s, wi)
    await finish(s, wi, 'implement', s.dev, { text: 'code' })
    await finish(s, wi, 'draft-tests', s.qc, { text: 'tests' })
    await finish(s, wi, 'review-code', s.dev, changes)
    await finish(s, wi, 'implement', s.dev, { text: 'code v2' })
    await finish(s, wi, 'review-code', s.dev, changes)
    // The previous assignee keeps the task directly, as before.
    expect(await latest(wi, 'implement')).toMatchObject({ attempt: 3, state: 'open', assigneeId: s.dev.id })
    await finish(s, wi, 'implement', s.dev, { text: 'code v3' })
    await finish(s, wi, 'review-code', s.dev, approve)
    expect((await pendingAdvance(wi))!.payload).toEqual({ fromStep: 'dev', toStep: 'qc' })
  })
})

describe('parseDraftMeta', () => {
  it('strips the final note and reads it; a missing or invalid note counts as high with nothing missing', async () => {
    const { parseDraftMeta } = await import('../src/ai/drafter.js')
    expect(parseDraftMeta('# A\n\nbody\n<!--meta {"confidence":"low","missing":["x", " ", 3, "y"]}-->\n')).toEqual({
      text: '# A\n\nbody',
      meta: { confidence: 'low', missing: ['x', 'y'] },
    })
    expect(parseDraftMeta('# A\n<!--meta not json-->')).toEqual({ text: '# A', meta: { confidence: 'high', missing: [] } })
    expect(parseDraftMeta('# A\n<!--meta {"confidence":"maybe"}-->')).toEqual({ text: '# A', meta: { confidence: 'high', missing: [] } })
    expect(parseDraftMeta('# A')).toEqual({ text: '# A', meta: { confidence: 'high', missing: [] } })
    // Two notes: only the trailing one is stripped and read; the earlier text stays.
    expect(parseDraftMeta('# A\n<!--meta {"confidence":"high"}-->\nbody\n<!--meta {"confidence":"low","missing":["z"]}-->')).toEqual({
      text: '# A\n<!--meta {"confidence":"high"}-->\nbody',
      meta: { confidence: 'low', missing: ['z'] },
    })
    // A quoted `<!--meta` earlier in the body with a valid trailing note: the body is intact.
    expect(parseDraftMeta('use `<!--meta` notes\nmore\n<!--meta {"confidence":"low","missing":[]}-->')).toEqual({
      text: 'use `<!--meta` notes\nmore',
      meta: { confidence: 'low', missing: [] },
    })
    // A note that is not at the end is left in place.
    expect(parseDraftMeta('<!--meta {"confidence":"low"}-->\n# A').text).toBe('<!--meta {"confidence":"low"}-->\n# A')
  })
})
