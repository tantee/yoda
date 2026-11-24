import type { FastifyInstance } from 'fastify'
import type { Task, TaskWithContext, Todo, WorkItemDetail } from '@yoda/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, eq } from 'drizzle-orm'
import { DRAFT_MAX_OUTPUT_TOKENS, runDraft } from '../src/ai/drafter.js'
import { AiGateway } from '../src/ai/gateway.js'
import type { ModelSet } from '../src/ai/models.js'
import { aiCalls, events, knowledgeEntries, projects } from '../src/db/schema.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { textStream } from './ai-mocks.js'
import { mockModels, resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

const DRAFT = '# ข้อกำหนด\n\n- DRAFT-REQUIREMENTS-TEXT'

let app: FastifyInstance
let queue: InlineJobQueue
let admin: Who
let pm: Who
let ba: Who
let sa: Who
let outsider: Who
let requester: Who

/** A draft model whose calls are counted and whose prompts are captured; `fail` makes it throw. */
function draftModel(text = DRAFT, modelId = 'claude-opus-5-5') {
  const state = { calls: 0, prompts: [] as string[], fail: false, maxOutputTokens: [] as (number | undefined)[], signals: [] as (AbortSignal | undefined)[] }
  const model = new MockLanguageModelV4({
    modelId,
    doStream: async (opts) => {
      state.calls++
      state.prompts.push(JSON.stringify(opts.prompt))
      state.maxOutputTokens.push(opts.maxOutputTokens)
      state.signals.push(opts.abortSignal)
      if (state.fail) throw new Error('provider down')
      return { stream: textStream(text) }
    },
  })
  return { model, state }
}

/** Holds draft-task jobs until `release()`, so a test can act before the drafter runs. */
class HeldQueue extends InlineJobQueue {
  held: { name: JobName; id: string }[] = []
  override async send(name: JobName, data: { id: string }): Promise<void> {
    if (name === 'draft-task') this.held.push({ name, id: data.id })
    else await super.send(name, data)
  }
  async release(): Promise<void> {
    for (const j of this.held.splice(0)) await super.send(j.name, { id: j.id })
  }
}

async function boot(models: ModelSet, jobs: InlineJobQueue = new InlineJobQueue()) {
  const db = await testDb()
  queue = jobs
  app = await makeApp({ ai: new AiGateway({ db, bus: new LiveBus(), models }), jobs })
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  ba = await login(app, 'ba', { staff: true })
  sa = await login(app, 'sa', { staff: true })
  outsider = await login(app, 'outsider', { staff: true })
  requester = await login(app, 'nurse')
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [ba, ['BA']], [sa, ['SA']]] as [Who, string[]][]) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
    title: 'เพิ่มรายงาน HbA1c',
    description: 'ต้องการรายงานใหม่',
    templateKey: 'software-change',
    requesterId: requester.id,
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

async function active(itemId: string, key: string): Promise<Task> {
  const d = (await call(pm, 'GET', `/work-items/${itemId}`)).json() as WorkItemDetail
  return d.tasks.filter((t) => t.templateTaskKey === key).at(-1)!
}

async function approveIntake(itemId: string) {
  const t = await active(itemId, 'accept-intake')
  if (t.assigneeId !== pm.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
  expect((await call(pm, 'POST', `/tasks/${t.id}/submit`, { decision: 'approve', text: '' })).statusCode).toBe(200)
  // The finished intake step waits for the PM to confirm the advance (propose projects).
  expect(await acceptStepAdvance(app, pm, itemId)).toBe(true)
}

/** Hands the latest attempt of `key` to `who` (as the PM) when needed, then submits it. */
async function drive(itemId: string, key: string, who: Who, result: Record<string, unknown>) {
  const t = await active(itemId, key)
  if (t.assigneeId !== who.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  expect((await call(who, 'POST', `/tasks/${t.id}/submit`, result)).statusCode).toBe(200)
  await acceptStepAdvance(app, pm, itemId)
}

async function taskEvents(taskId: string) {
  const db = await testDb()
  return db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq))
}

async function callsFor(taskId: string) {
  const db = await testDb()
  return db.select().from(aiCalls).where(eq(aiCalls.taskId, taskId))
}

async function confirmations(): Promise<string[]> {
  return ((await call(pm, 'GET', '/me/todo')).json() as Todo).confirmations.map((t) => t.id)
}

describe('AI drafter', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })
  afterEach(async () => {
    await queue.drain()
    await app.close()
  })

  it('drafts draft-requirements after intake approval and asks the requester with the draft', async () => {
    const m = draftModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()

    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'accepted', executor: 'ai', assigneeId: null })
    expect(draft.result).toMatchObject({ text: DRAFT })
    const evs = await taskEvents(draft.id)
    const drafted = evs.find((e) => e.type === 'ai.drafted')
    const accepted = evs.find((e) => e.type === 'task.accepted')
    expect(drafted).toMatchObject({ actorKind: 'ai', actorId: null, payload: { model: 'claude-opus-5-5' } })
    expect(accepted).toMatchObject({ actorKind: 'ai', actorId: null })
    expect(drafted!.seq).toBeLessThan(accepted!.seq)

    const answer = await active(wi.id, 'answer-questions')
    expect(answer).toMatchObject({ state: 'open', assigneeId: requester.id })
    const detail = (await call(requester, 'GET', `/tasks/${answer.id}`)).json() as TaskWithContext
    expect(detail.inputs.map((i) => i.result.text)).toContain(DRAFT)
    await drive(wi.id, 'answer-questions', requester, { text: 'คำตอบของผู้ขอ' })
    const clarify = await active(wi.id, 'clarify-requirements')
    const forBa = (await call(ba, 'GET', `/tasks/${clarify.id}`)).json() as TaskWithContext
    expect(forBa.inputs.map((i) => [i.templateTaskKey, i.result.text])).toEqual([
      ['draft-requirements', DRAFT],
      ['answer-questions', 'คำตอบของผู้ขอ'],
    ])

    const db = await testDb()
    const progress = await db
      .select()
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.sourceRef, draft.id), eq(knowledgeEntries.type, 'progress')))
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ status: 'draft', body: DRAFT })
    expect(await callsFor(draft.id)).toMatchObject([{ ok: true, job: 'draft' }])
  })

  it('the prompt carries the work item title but never a noAi document body', async () => {
    const m = draftModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    const db = await testDb()
    await db.insert(knowledgeEntries).values([
      { lineageId: crypto.randomUUID(), version: 1, scope: 'work_item', projectId: p, workItemId: wi.id, type: 'document',
        title: 'ลับ', body: 'SECRET-NOAI-BODY HbA1c', status: 'confirmed', sourceKind: 'person', noAi: true },
      { lineageId: crypto.randomUUID(), version: 1, scope: 'work_item', projectId: p, workItemId: wi.id, type: 'document',
        title: 'เปิด', body: 'VISIBLE-DOC-BODY', status: 'confirmed', sourceKind: 'person' },
    ])
    await approveIntake(wi.id)
    await queue.drain()

    expect(m.state.calls).toBe(1)
    const prompt = m.state.prompts[0]!
    expect(prompt).toContain('เพิ่มรายงาน HbA1c')
    expect(prompt).toContain('VISIBLE-DOC-BODY')
    expect(prompt).not.toContain('SECRET-NOAI-BODY')
  })

  it('a project over budget gets no model call; the task returns to the PM with budget_exceeded', async () => {
    const m = draftModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '1.00' }).where(eq(projects.id, p))
    await db.insert(aiCalls).values({ projectId: p, job: 'draft', provider: 'anthropic', model: 'x', costUsd: '2.000000', ok: true })
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()

    expect(m.state.calls).toBe(0)
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', assigneeId: null, executor: 'ai', result: null })
    const failed = (await taskEvents(draft.id)).filter((e) => e.type === 'ai.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ reason: 'budget_exceeded', actorKind: 'system' })
    expect(await confirmations()).toContain(draft.id)
  })

  it('no draft model configured → ai_unavailable at once, no ai_calls row', async () => {
    await boot(mockModels({ draft: null, ids: { draft: null, fast: 'anthropic:claude-haiku-5-5', embed: null } }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()

    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', assigneeId: null })
    const failed = (await taskEvents(draft.id)).filter((e) => e.type === 'ai.failed')
    expect(failed.map((e) => e.reason)).toEqual(['ai_unavailable'])
    expect(await callsFor(draft.id)).toHaveLength(0)
  })

  it('a model failing every time → ai_failed after the final retry, 3 failed calls, no result', async () => {
    const m = draftModel()
    m.state.fail = true
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()

    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', assigneeId: null, result: null })
    const failed = (await taskEvents(draft.id)).filter((e) => e.type === 'ai.failed')
    expect(failed.map((e) => e.reason)).toEqual(['ai_failed'])
    const calls = await callsFor(draft.id)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => !c.ok)).toBe(true)
    expect(await confirmations()).toContain(draft.id)
  })

  it('a PM taking the ai task over before the job runs → the job does nothing', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    expect(held.held).toHaveLength(1)
    const draft = await active(wi.id, 'draft-requirements')
    expect((await call(pm, 'POST', `/tasks/${draft.id}/assign`, { personId: ba.id })).statusCode).toBe(200)
    await held.release()
    await held.drain()

    expect(m.state.calls).toBe(0)
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ state: 'open', executor: 'human', assigneeId: ba.id })
    const types = (await taskEvents(draft.id)).map((e) => e.type)
    expect(types).not.toContain('ai.drafted')
    expect(types).not.toContain('ai.failed')
  })

  it('aiStatus: drafting while the job is pending, failed with its reason, null for human tasks', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const wi = await createItem(p)
    const intake = await active(wi.id, 'accept-intake')
    expect(intake).toMatchObject({ aiStatus: null, aiFailReason: null })
    await approveIntake(wi.id)

    const pending = await active(wi.id, 'draft-requirements')
    expect(pending).toMatchObject({ aiStatus: 'drafting', aiFailReason: null })
    const todo = (await call(pm, 'GET', '/me/todo')).json() as Todo
    expect(todo.confirmations.find((t) => t.id === pending.id)).toMatchObject({ aiStatus: 'drafting' })

    m.state.fail = true
    await held.release()
    await held.drain()
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ aiStatus: 'failed', aiFailReason: 'ai_failed' })
    const one = (await call(pm, 'GET', `/tasks/${pending.id}`)).json() as TaskWithContext
    expect(one).toMatchObject({ aiStatus: 'failed', aiFailReason: 'ai_failed' })

    // Retry: drafting again until the job finishes, then done (null).
    m.state.fail = false
    expect((await call(pm, 'POST', `/tasks/${pending.id}/retry-ai`)).statusCode).toBe(200)
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ aiStatus: 'drafting' })
    await held.release()
    await held.drain()
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ state: 'accepted', aiStatus: null })
  })

  it('aiStatus is failed with budget_exceeded, null once a person takes the task', async () => {
    const m = draftModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '1.00' }).where(eq(projects.id, p))
    await db.insert(aiCalls).values({ projectId: p, job: 'draft', provider: 'anthropic', model: 'x', costUsd: '2.000000', ok: true })
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ aiStatus: 'failed', aiFailReason: 'budget_exceeded' })
    expect((await call(pm, 'POST', `/tasks/${draft.id}/assign`, { personId: ba.id })).statusCode).toBe(200)
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ aiStatus: null })
  })

  it('POST /tasks/:id/retry-ai redrafts a failed draft; 409 once accepted; 403 / 404 for others', async () => {
    const m = draftModel()
    m.state.fail = true
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft.state).toBe('open')

    expect((await call(ba, 'POST', `/tasks/${draft.id}/retry-ai`)).statusCode).toBe(403)
    expect((await call(requester, 'POST', `/tasks/${draft.id}/retry-ai`)).statusCode).toBe(403)
    expect((await call(outsider, 'POST', `/tasks/${draft.id}/retry-ai`)).statusCode).toBe(404)

    m.state.fail = false
    const res = await call(pm, 'POST', `/tasks/${draft.id}/retry-ai`)
    expect(res.statusCode).toBe(200)
    await queue.drain()
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ id: draft.id, state: 'accepted', result: { text: DRAFT } })
    expect(await active(wi.id, 'answer-questions')).toBeTruthy()

    const again = await call(pm, 'POST', `/tasks/${draft.id}/retry-ai`)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'invalid_state' })
  })

  it('retry-ai with no ai.* event yet (job lost or pending) queues a job; a second retry before it runs → 409', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    const draft = await active(wi.id, 'draft-requirements')
    held.held.splice(0) // the original job was lost
    expect((await call(pm, 'POST', `/tasks/${draft.id}/retry-ai`)).statusCode).toBe(200)
    expect(held.held).toHaveLength(1)
    const again = await call(pm, 'POST', `/tasks/${draft.id}/retry-ai`)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'invalid_state' })
    expect(held.held).toHaveLength(1)
    await held.release()
    await held.drain()
    expect(m.state.calls).toBe(1)
    expect(await active(wi.id, 'draft-requirements')).toMatchObject({ state: 'accepted', aiStatus: null })
  })

  it('switching noAi off queues drafting for waiting tasks (marking failed ones as retried)', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const db = await testDb()
    // Item A: drafted while the project turned noAi → ai.failed(no_ai).
    const a = await createItem(p)
    await approveIntake(a.id)
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, p))
    await held.release()
    await held.drain()
    const draftA = await active(a.id, 'draft-requirements')
    expect((await taskEvents(draftA.id)).filter((e) => e.type === 'ai.failed').map((e) => e.reason)).toEqual(['no_ai'])
    // Item B: created while noAi, so never queued.
    const b = await createItem(p)
    await approveIntake(b.id)
    const draftB = await active(b.id, 'draft-requirements')
    expect(held.held).toHaveLength(0)

    // Unchanged / true → true never queues.
    expect((await call(pm, 'PATCH', `/projects/${p}`, { noAi: true })).statusCode).toBe(200)
    expect(held.held).toHaveLength(0)
    expect((await call(pm, 'PATCH', `/projects/${p}`, { noAi: false })).statusCode).toBe(200)
    expect(held.held.map((j) => j.id).sort()).toEqual([draftA.id, draftB.id].sort())
    expect(await active(a.id, 'draft-requirements')).toMatchObject({ aiStatus: 'drafting' })
    expect((await taskEvents(draftA.id)).at(-1)).toMatchObject({ type: 'ai.retried' })
    expect((await taskEvents(draftB.id)).map((e) => e.type)).not.toContain('ai.retried')
    // false → false does not queue again.
    expect((await call(pm, 'PATCH', `/projects/${p}`, { noAi: false })).statusCode).toBe(200)
    expect(held.held).toHaveLength(2)

    await held.release()
    await held.drain()
    expect(m.state.calls).toBe(2)
    expect(await active(a.id, 'draft-requirements')).toMatchObject({ state: 'accepted' })
    expect(await active(b.id, 'draft-requirements')).toMatchObject({ state: 'accepted' })
  })

  it('drafts with maxOutputTokens 16000 and forwards the job abort signal', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    const draft = await active(wi.id, 'draft-requirements')
    const ac = new AbortController()
    await runDraft(app.deps, draft.id, { isFinalAttempt: true, signal: ac.signal })
    expect(m.state.maxOutputTokens).toEqual([DRAFT_MAX_OUTPUT_TOKENS])
    expect(DRAFT_MAX_OUTPUT_TOKENS).toBe(16000)
    expect(m.state.signals[0]).toBeDefined()
    held.held.splice(0)
  })

  it('an unpriced draft model on a budgeted project → ai_unavailable, no model call', async () => {
    const m = draftModel(DRAFT, 'mystery-model')
    await boot(mockModels({ draft: m.model, ids: { draft: 'anthropic:mystery-model', fast: null, embed: null } }))
    const p = await project()
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '100.00' }).where(eq(projects.id, p))
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()
    expect(m.state.calls).toBe(0)
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', aiStatus: 'failed', aiFailReason: 'ai_unavailable' })
  })

  it('a noAi project never enqueues drafting; retry-ai → 409 with no job and no event', async () => {
    const m = draftModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const db = await testDb()
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, p))
    const wi = await createItem(p)
    await approveIntake(wi.id)
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', executor: 'ai', assigneeId: null })
    expect(held.held).toHaveLength(0)

    const before = (await taskEvents(draft.id)).length
    const res = await call(pm, 'POST', `/tasks/${draft.id}/retry-ai`)
    expect(res.statusCode).toBe(409)
    expect(held.held).toHaveLength(0)
    expect(await taskEvents(draft.id)).toHaveLength(before)
    await held.release()
    await held.drain()
    expect(m.state.calls).toBe(0)
  })

  it('a "changes" rejection recreates the ai draft-text task, which is drafted again with the feedback', async () => {
    const m = draftModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()
    await drive(wi.id, 'answer-questions', requester, { text: 'คำตอบ' })
    await drive(wi.id, 'clarify-requirements', ba, { text: 'ข้อกำหนดฉบับสมบูรณ์' })
    await drive(wi.id, 'approve-requirements', ba, { decision: 'approve', text: '' })
    await queue.drain()
    const design1 = await active(wi.id, 'draft-design')
    expect(design1).toMatchObject({ attempt: 1, state: 'accepted', executor: 'ai' })

    await drive(wi.id, 'approve-design', sa, { decision: 'changes', text: 'FEEDBACK-ADD-SEQUENCE-DIAGRAM' })
    await queue.drain()
    const design2 = await active(wi.id, 'draft-design')
    expect(design2).toMatchObject({ attempt: 2, state: 'accepted', executor: 'ai', result: { text: DRAFT } })
    expect(design2.id).not.toBe(design1.id)
    expect(m.state.prompts.at(-1)).toContain('FEEDBACK-ADD-SEQUENCE-DIAGRAM')
    expect((await taskEvents(design2.id)).map((e) => e.type)).toContain('ai.drafted')
  })

  it('empty model output → ai_failed at once, no retry', async () => {
    const m = draftModel('')
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await approveIntake(wi.id)
    await queue.drain()

    expect(m.state.calls).toBe(1)
    const draft = await active(wi.id, 'draft-requirements')
    expect(draft).toMatchObject({ state: 'open', assigneeId: null, result: null })
    const failed = (await taskEvents(draft.id)).filter((e) => e.type === 'ai.failed')
    expect(failed.map((e) => e.reason)).toEqual(['ai_failed'])
    expect(await callsFor(draft.id)).toMatchObject([{ ok: false, error: 'empty_output' }])
  })
})
