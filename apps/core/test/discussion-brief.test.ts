import type { FastifyInstance } from 'fastify'
import type { Discussion, DiscussionBrief, WorkItemDetail } from '@yoda/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { BRIEF_MAX_OUTPUT_TOKENS } from '../src/discussions/brief.js'
import { AiGateway } from '../src/ai/gateway.js'
import type { ModelSet } from '../src/ai/models.js'
import { aiCalls, departmentSettings, discussions, events, knowledgeEntries, projects } from '../src/db/schema.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { textStream } from './ai-mocks.js'
import { mockModels, resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let queue: InlineJobQueue
let admin: Who
let pm: Who
let dev: Who
let ba: Who

const GOOD = {
  context: 'ห้องแล็บต้องการรายงาน HbA1c ภายในไตรมาสนี้',
  options: [
    { key: 'a', title: 'ใช้ระบบเดิม', pros: 'เร็ว', cons: 'ขยายยาก' },
    { key: 'b', title: 'สร้างระบบใหม่', pros: 'ยืดหยุ่น', cons: 'ใช้เวลานาน' },
  ],
  recommendation: 'แนะนำให้ใช้ระบบเดิมก่อน',
  recommendedKey: 'a',
}

/** A draft model returning `output` as JSON; calls, prompts and options are captured. */
function briefModel(output: unknown = GOOD) {
  const state = {
    calls: 0,
    prompts: [] as string[],
    maxOutputTokens: [] as (number | undefined)[],
    responseFormats: [] as unknown[],
    output,
    before: null as null | (() => Promise<void>),
  }
  const model = new MockLanguageModelV4({
    modelId: 'claude-opus-5-5',
    doStream: async (opts) => {
      state.calls++
      state.prompts.push(JSON.stringify(opts.prompt))
      state.maxOutputTokens.push(opts.maxOutputTokens)
      state.responseFormats.push(opts.responseFormat)
      if (state.before) await state.before()
      const out = state.output
      return { stream: textStream(typeof out === 'string' ? out : JSON.stringify(out)) }
    },
  })
  return { model, state }
}

/** Holds discussion-brief jobs until `release()`, so a test can act before the brief job runs. */
class HeldQueue extends InlineJobQueue {
  held: { name: JobName; id: string }[] = []
  override async send(name: JobName, data: { id: string }): Promise<void> {
    if (name === 'discussion-brief') this.held.push({ name, id: data.id })
    else await super.send(name, data)
  }
  async release(): Promise<void> {
    for (const j of this.held.splice(0)) await super.send(j.name, { id: j.id })
  }
}

async function boot(models: ModelSet, jobs: InlineJobQueue = new InlineJobQueue()) {
  const db = await testDb()
  queue = jobs
  app = await makeApp({ ai: new AiGateway({ db, bus: new LiveBus(), models, config: { dailyTaskCap: 8 } }), jobs })
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  ba = await login(app, 'ba', { staff: true })
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [dev, ['DEV']], [ba, ['BA']]] as [Who, string[]][]) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
    title: 'เพิ่มรายงาน HbA1c',
    description: 'WORK-ITEM-DESCRIPTION',
    templateKey: 'software-change',
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

async function raise(who: Who, body: Record<string, unknown>): Promise<Discussion> {
  const res = await call(who, 'POST', '/discussions', body)
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

const get = async (id: string): Promise<Discussion> => (await call(dev, 'GET', `/discussions/${id}`)).json()

async function discussionEvents(id: string) {
  const db = await testDb()
  const rows = await db.select().from(events).orderBy(asc(events.seq))
  return rows.filter((e) => (e.payload as { discussionId?: string } | null)?.discussionId === id)
}

async function entry(values: Partial<typeof knowledgeEntries.$inferInsert>) {
  const db = await testDb()
  await db.insert(knowledgeEntries).values({
    lineageId: crypto.randomUUID(),
    version: 1,
    scope: 'project',
    type: 'document',
    title: 'doc',
    body: '',
    status: 'confirmed',
    sourceKind: 'person',
    ...values,
  })
}

describe('AI discussion briefs', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })
  afterEach(async () => {
    await queue.drain()
    await app.close()
  })

  it('prepares a brief from the work item context; a vote on an AI option works', async () => {
    const m = briefModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const wi = await createItem(p)
    await entry({ scope: 'work_item', projectId: p, workItemId: wi.id, title: 'ข้อกำหนด', body: 'CONFIRMED-DOC-BODY HbA1c' })
    await entry({ scope: 'work_item', projectId: p, workItemId: wi.id, title: 'ลับ', body: 'SECRET-NOAI-BODY HbA1c', noAi: true })
    await entry({ scope: 'work_item', projectId: p, workItemId: wi.id, type: 'decision', title: 'ตัดสินแล้ว', body: 'EARLIER-DECISION' })
    await entry({ scope: 'work_item', projectId: p, workItemId: wi.id, type: 'progress', title: 'ความคืบหน้า', body: 'RECENT-PROGRESS', status: 'draft' })
    await entry({ scope: 'work_item', projectId: p, workItemId: wi.id, title: 'ร่าง', body: 'UNCONFIRMED-DOC', status: 'draft' })

    const d = await raise(dev, {
      workItemId: wi.id,
      question: 'ควรใช้ระบบเดิมหรือสร้างใหม่สำหรับ HbA1c?',
      details: 'DISCUSSION-DETAILS',
      options: [{ key: 'x', title: 'PERSON-HINT-OPTION', pros: '', cons: '' }],
    })
    expect(d.brief).toMatchObject({ status: 'pending', source: 'ai' })
    await queue.drain()

    expect(m.state.calls).toBe(1)
    expect(m.state.maxOutputTokens).toEqual([BRIEF_MAX_OUTPUT_TOKENS])
    expect(BRIEF_MAX_OUTPUT_TOKENS).toBe(6000)
    expect(m.state.responseFormats[0]).toMatchObject({ type: 'json' })
    const prompt = m.state.prompts[0]!
    for (const s of ['ควรใช้ระบบเดิมหรือสร้างใหม่', 'DISCUSSION-DETAILS', 'PERSON-HINT-OPTION', 'เพิ่มรายงาน HbA1c', 'WORK-ITEM-DESCRIPTION', wi.currentStepKey!, 'CONFIRMED-DOC-BODY', 'EARLIER-DECISION', 'RECENT-PROGRESS']) {
      expect(prompt).toContain(s)
    }
    expect(prompt).not.toContain('SECRET-NOAI-BODY')
    expect(prompt).not.toContain('UNCONFIRMED-DOC')

    const after = await get(d.id)
    expect(after.brief).toEqual({ ...GOOD, options: GOOD.options, source: 'ai', status: 'ready', failReason: null })
    const evs = await discussionEvents(d.id)
    expect(evs.filter((e) => e.type === 'discussion.brief_ready')).toHaveLength(1)
    expect(evs.find((e) => e.type === 'discussion.brief_ready')).toMatchObject({ actorKind: 'ai', workItemId: wi.id })

    const db = await testDb()
    expect(await db.select().from(aiCalls)).toMatchObject([{ projectId: p, job: 'draft', ok: true }])

    const vote = await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })
    expect(vote.statusCode, vote.body).toBe(200)
    expect((await get(d.id)).voteCounts).toEqual({ a: 1 })
  })

  it('a no-AI project: no model call, the brief fails with no_ai, and a manual brief still works', async () => {
    const m = briefModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    expect((await call(admin, 'PATCH', `/projects/${p}`, { noAi: true })).statusCode).toBe(200)
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    await queue.drain()
    expect(m.state.calls).toBe(0)
    expect((await get(d.id)).brief).toMatchObject({ status: 'failed', failReason: 'no_ai' })

    const edit = { context: 'บริบท', options: GOOD.options, recommendation: '', recommendedKey: null }
    expect((await call(dev, 'PUT', `/discussions/${d.id}/brief`, edit)).statusCode).toBe(200)
    expect((await get(d.id)).brief).toMatchObject({ source: 'person', status: 'ready' })
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'b' })).statusCode).toBe(200)
  })

  it('a project flagged no-AI after the raise: the job makes no model call and fails with no_ai', async () => {
    const m = briefModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'เลือกแนวทาง' })
    expect((await call(admin, 'PATCH', `/projects/${p}`, { noAi: true })).statusCode).toBe(200)
    await held.release()
    await queue.drain()
    expect(m.state.calls).toBe(0)
    expect((await get(d.id)).brief).toMatchObject({ source: 'ai', status: 'failed', failReason: 'no_ai' })
    const failed = (await discussionEvents(d.id)).filter((e) => e.type === 'discussion.brief_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ reason: 'no_ai', actorKind: 'system' })
  })

  it('budget exhausted: no model call, the brief fails with budget_exceeded', async () => {
    const m = briefModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const db = await testDb()
    await db.update(projects).set({ aiBudgetUsd: '1.00' }).where(eq(projects.id, p))
    await db.insert(aiCalls).values({ projectId: p, job: 'draft', provider: 'anthropic', model: 'x', costUsd: '2.000000', ok: true })
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    await queue.drain()
    expect(m.state.calls).toBe(0)
    expect((await get(d.id)).brief).toMatchObject({ status: 'failed', failReason: 'budget_exceeded' })
    expect((await discussionEvents(d.id)).filter((e) => e.type === 'discussion.brief_failed')).toMatchObject([
      { reason: 'budget_exceeded' },
    ])
  })

  it('malformed model output is retried, then the brief fails with ai_failed', async () => {
    const bad = [
      'not json at all',
      { ...GOOD, options: GOOD.options.slice(0, 1) },
      { ...GOOD, recommendedKey: 'e' },
      { ...GOOD, options: [GOOD.options[0], { ...GOOD.options[1], key: 'a' }] },
      { ...GOOD, options: [{ ...GOOD.options[0], key: 'z' }, GOOD.options[1]] },
    ]
    for (const output of bad) {
      await resetDb(await testDb())
      const m = briefModel(output)
      await boot(mockModels({ draft: m.model }))
      const p = await project()
      const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
      await queue.drain()
      expect(m.state.calls, JSON.stringify(output)).toBe(3)
      expect((await get(d.id)).brief).toMatchObject({ source: 'ai', status: 'failed', failReason: 'ai_failed', options: [] })
      const db = await testDb()
      const rows = await db.select().from(aiCalls).where(eq(aiCalls.projectId, p))
      expect(rows).toHaveLength(3)
      // Billed though unusable: tokens are kept.
      expect(rows.every((r) => !r.ok && r.error === 'invalid_output' && r.inputTokens === 1000)).toBe(true)
      await queue.drain()
      await app.close()
    }
    // afterEach closes the last app again: boot a fresh one so it has something to close.
    await boot(mockModels())
  })

  it('retry: raiser / PM / admin re-queue a failed brief; anything else → 409', async () => {
    const m = briefModel('garbage')
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    await queue.drain()
    expect((await get(d.id)).brief).toMatchObject({ status: 'failed', failReason: 'ai_failed' })

    expect((await call(ba, 'POST', `/discussions/${d.id}/brief/retry`)).statusCode).toBe(403)
    m.state.output = GOOD
    const res = await call(dev, 'POST', `/discussions/${d.id}/brief/retry`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().brief).toMatchObject({ status: 'pending', source: 'ai', failReason: null })
    // Pending (and then ready): a second retry is a conflict.
    expect((await call(pm, 'POST', `/discussions/${d.id}/brief/retry`)).statusCode).toBe(409)
    await queue.drain()
    expect((await get(d.id)).brief).toMatchObject({ status: 'ready', source: 'ai', recommendedKey: 'a' })
    expect((await call(admin, 'POST', `/discussions/${d.id}/brief/retry`)).statusCode).toBe(409)

    // A decided discussion cannot be retried.
    m.state.output = 'garbage'
    const d2 = await raise(dev, { projectId: p, question: 'อีกเรื่อง' })
    await queue.drain()
    expect((await call(pm, 'POST', `/discussions/${d2.id}/decide`, { decision: 'จบ' })).statusCode).toBe(200)
    expect((await call(pm, 'POST', `/discussions/${d2.id}/brief/retry`)).statusCode).toBe(409)
  })

  it('a person editing the brief while the AI generates wins', async () => {
    const m = briefModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const edit = { context: 'PERSON-CONTEXT', options: GOOD.options, recommendation: '', recommendedKey: null }
    let id = ''
    m.state.before = async () => {
      expect((await call(dev, 'PUT', `/discussions/${id}/brief`, edit)).statusCode).toBe(200)
    }
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    id = d.id
    await queue.drain()
    expect(m.state.calls).toBe(1)
    expect((await get(d.id)).brief).toMatchObject({ context: 'PERSON-CONTEXT', source: 'person', status: 'ready' })
    expect((await discussionEvents(d.id)).filter((e) => e.type === 'discussion.brief_ready')).toEqual([])
  })

  it('a withdrawn discussion gets no brief call', async () => {
    const m = briefModel()
    const held = new HeldQueue()
    await boot(mockModels({ draft: m.model }), held)
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    expect((await call(dev, 'POST', `/discussions/${d.id}/withdraw`, { reason: 'ซ้ำ' })).statusCode).toBe(200)
    await held.release()
    await queue.drain()
    expect(m.state.calls).toBe(0)
    expect((await get(d.id)).brief).toMatchObject({ status: 'pending' })
  })

  it('department discussions: question and department knowledge only, billed to the department', async () => {
    const m = briefModel()
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    await entry({ scope: 'department', title: 'นโยบาย AI', body: 'DEPT-POLICY นโยบายข้อมูลผู้ป่วย' })
    await entry({ scope: 'project', projectId: p, title: 'โครงการ', body: 'PROJECT-ONLY นโยบายข้อมูลผู้ป่วย' })
    await entry({ scope: 'department', title: 'ลับ', body: 'DEPT-SECRET นโยบายข้อมูลผู้ป่วย', noAi: true })
    const db = await testDb()
    await db.update(departmentSettings).set({ aiBudgetUsd: '10.00' })

    const d = await raise(dev, { question: 'นโยบายข้อมูลผู้ป่วย' })
    await queue.drain()
    expect(m.state.calls).toBe(1)
    const prompt = m.state.prompts[0]!
    expect(prompt).toContain('DEPT-POLICY')
    expect(prompt).not.toContain('PROJECT-ONLY')
    expect(prompt).not.toContain('DEPT-SECRET')
    expect((await get(d.id)).brief).toMatchObject({ status: 'ready', source: 'ai' })
    const rows = await db.select().from(aiCalls).where(isNull(aiCalls.projectId))
    expect(rows).toMatchObject([{ job: 'draft', ok: true }])

    // Department budget exhausted → budget_exceeded.
    await db.update(departmentSettings).set({ aiBudgetUsd: '0.00' })
    const d2 = await raise(dev, { question: 'อีกเรื่อง' })
    await queue.drain()
    expect(m.state.calls).toBe(1)
    expect((await get(d2.id)).brief).toMatchObject({ status: 'failed', failReason: 'budget_exceeded' })
  })

  it('the stored brief is clipped to the shared schema limits', async () => {
    const long = 'ก'.repeat(30_000)
    const m = briefModel({ ...GOOD, context: long, recommendation: long, options: GOOD.options.map((o) => ({ ...o, title: long, pros: long })) })
    await boot(mockModels({ draft: m.model }))
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    await queue.drain()
    const db = await testDb()
    const [row] = await db.select().from(discussions).where(and(eq(discussions.id, d.id)))
    const brief = row!.brief as DiscussionBrief
    expect(brief.status).toBe('ready')
    expect(brief.context.length).toBe(20000)
    expect(brief.recommendation.length).toBe(4000)
    expect(brief.options[0]!.title.length).toBe(200)
    expect(brief.options[0]!.pros.length).toBe(4000)
  })
})
