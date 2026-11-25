import type { FastifyInstance } from 'fastify'
import type { Discussion, DiscussionResponse, LiveEvent, Me, Notification, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { discussionResponses, discussions, events, knowledgeEntries, projectMembers } from '../src/db/schema.js'
import { AI_BRIEF_HEADING, decideDiscussion, lockDiscussion, recordDiscussionEvent } from '../src/discussions/service.js'
import type { InlineJobQueue } from '../src/jobs/queue.js'
import { searchKnowledge } from '../src/knowledge/search.js'
import { deliverable } from '../src/routes/stream.js'
import { recordEvent, runWork } from '../src/work/context.js'
import { lockItem } from '../src/work/engine.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let pm2: Who
let dev: Who
let ba: Who
let outsider: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

const asMe = (w: Who, name: string, isAdmin = false): Me => ({
  id: w.id,
  username: name,
  displayName: name,
  email: null,
  isStaff: true,
  isAdmin,
})

const OPTIONS = [
  { key: 'a', title: 'ใช้ระบบเดิม', pros: 'เร็ว', cons: 'ขยายยาก' },
  { key: 'b', title: 'สร้างระบบใหม่', pros: 'ยืดหยุ่น', cons: 'ใช้เวลานาน' },
]

async function project(name = 'ระบบรายงานแล็บ'): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [pm2, ['PM']], [dev, ['DEV']], [ba, ['BA']]] as [Who, string[]][]) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'เพิ่มรายงาน HbA1c', templateKey: 'software-change' })
  expect(res.statusCode).toBe(201)
  return res.json()
}

async function raise(who: Who, body: Record<string, unknown>): Promise<Discussion> {
  const res = await call(who, 'POST', '/discussions', body)
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

const notifications = async (who: Who): Promise<Notification[]> => (await call(who, 'GET', '/me/notifications')).json()
const discussionNotes = async (who: Who) => (await notifications(who)).filter((n) => n.kind === 'discussion')
const drain = () => (app.deps.jobs as InlineJobQueue).drain()

describe('discussions', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true, name: 'สมศรี' })
    pm2 = await login(app, 'pm2', { staff: true })
    dev = await login(app, 'dev', { staff: true, name: 'สมชาย' })
    ba = await login(app, 'ba', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('a member raises a discussion on a work item; the PMs are notified once', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ควรใช้ระบบเดิมหรือสร้างใหม่?', details: 'รายละเอียด', priority: 'high' })
    expect(d).toMatchObject({
      projectId: p,
      projectName: 'ระบบรายงานแล็บ',
      workItemId: wi.id,
      workItemTitle: 'เพิ่มรายงาน HbA1c',
      taskId: null,
      stepKey: wi.currentStepKey,
      question: 'ควรใช้ระบบเดิมหรือสร้างใหม่?',
      priority: 'high',
      state: 'open',
      raisedById: dev.id,
      raisedByName: 'สมชาย',
      decision: null,
      voteCounts: {},
      myVote: null,
      responseCount: 0,
    })
    // requestBrief defaults to true: the AI brief is pending (the job arrives with Task 5).
    expect(d.brief).toMatchObject({ status: 'pending', source: 'ai', options: [] })

    const db = await testDb()
    const raised = await db.select().from(events).where(and(eq(events.workItemId, wi.id), eq(events.type, 'discussion.raised')))
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ actorId: dev.id, payload: { discussionId: d.id } })

    for (const who of [pm, pm2]) {
      const notes = await discussionNotes(who)
      expect(notes).toHaveLength(1)
      expect(notes[0]!.link).toBe(`/discussions/${d.id}`)
    }
    expect(await discussionNotes(dev)).toEqual([])
    expect(await discussionNotes(ba)).toEqual([])

    // Read back.
    const got = await call(ba, 'GET', `/discussions/${d.id}`)
    expect(got.statusCode).toBe(200)
    expect(got.json()).toMatchObject({ id: d.id, question: d.question })
  })

  it('stores provided options as a ready person brief when no AI brief is requested', async () => {
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง', options: OPTIONS, requestBrief: false })
    expect(d.workItemId).toBeNull()
    expect(d.brief).toMatchObject({ source: 'person', status: 'ready', options: OPTIONS, failReason: null })

    // A no-AI project never gets an AI brief: the request fails at once with a visible reason.
    expect((await call(admin, 'PATCH', `/projects/${p}`, { noAi: true })).statusCode).toBe(200)
    const d2 = await raise(dev, { projectId: p, question: 'อีกเรื่อง', options: OPTIONS })
    expect(d2.brief).toMatchObject({ source: 'ai', status: 'failed', failReason: 'no_ai', options: OPTIONS })
  })

  it('validates the project / work item / task links and the work item state', async () => {
    const p = await project()
    const q = await project('โครงการอื่น')
    const wi = await createItem(p)
    const other = await createItem(q)
    const mismatch = await call(dev, 'POST', '/discussions', { projectId: q, workItemId: wi.id, question: 'x' })
    expect(mismatch.statusCode).toBe(422)
    expect(mismatch.json()).toEqual({ error: 'invalid_state' })
    const foreignTask = await call(dev, 'POST', '/discussions', { workItemId: wi.id, taskId: other.tasks[0]!.id, question: 'x' })
    expect(foreignTask.statusCode).toBe(404)
    const withTask = await raise(dev, { workItemId: wi.id, taskId: wi.tasks[0]!.id, question: 'x' })
    expect(withTask).toMatchObject({ projectId: p, taskId: wi.tasks[0]!.id, stepKey: wi.tasks[0]!.stepKey })
    expect((await call(dev, 'POST', '/discussions', { taskId: wi.tasks[0]!.id, question: 'x' })).statusCode).toBe(400)
    // Outsiders cannot raise on a project they cannot see.
    expect((await call(outsider, 'POST', '/discussions', { workItemId: wi.id, question: 'x' })).statusCode).toBe(404)
    expect((await call(outsider, 'POST', '/discussions', { projectId: p, question: 'x' })).statusCode).toBe(404)
    // Duplicate option keys are refused.
    const dup = await call(dev, 'POST', '/discussions', { projectId: p, question: 'x', options: [OPTIONS[0], OPTIONS[0]] })
    expect(dup.statusCode).toBe(422)
    // Only active work items.
    expect((await call(pm, 'POST', `/work-items/${wi.id}/cancel`)).statusCode).toBe(200)
    expect((await call(dev, 'POST', '/discussions', { workItemId: wi.id, question: 'x' })).statusCode).toBe(409)
  })

  it('staff outside the project get 404; requesters get 403 everywhere', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ลับ', options: OPTIONS, requestBrief: false })
    const routes: ['GET' | 'POST' | 'PUT', string, unknown?][] = [
      ['GET', `/discussions/${d.id}`],
      ['GET', `/discussions/${d.id}/responses`],
      ['POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'เห็นด้วย' }],
      ['PUT', `/discussions/${d.id}/brief`, { context: '', options: OPTIONS, recommendation: '', recommendedKey: null }],
      ['POST', `/discussions/${d.id}/decide`, { decision: 'ตกลง' }],
      ['POST', `/discussions/${d.id}/withdraw`, { reason: 'ไม่ต้องแล้ว' }],
    ]
    for (const [method, url, body] of routes) {
      expect((await call(outsider, method, url, body)).statusCode, `${method} ${url}`).toBe(404)
      expect((await call(nurse, method, url, body)).statusCode, `${method} ${url}`).toBe(403)
    }
    expect((await call(outsider, 'GET', `/discussions?projectId=${p}`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', '/discussions')).json()).toEqual([])
    expect((await call(nurse, 'GET', '/discussions')).statusCode).toBe(403)
    expect((await call(nurse, 'POST', '/discussions', { projectId: p, question: 'x' })).statusCode).toBe(403)
    expect((await call(nurse, 'POST', '/discussions', { question: 'x' })).statusCode).toBe(403)
    expect((await call(dev, 'GET', `/discussions/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404)
    // Nothing changed.
    const after = (await call(dev, 'GET', `/discussions/${d.id}`)).json() as Discussion
    expect(after).toMatchObject({ state: 'open', responseCount: 0 })
  })

  it('opinions and votes: a second vote replaces the first; an unknown option → 422', async () => {
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง', options: OPTIONS, requestBrief: false })
    const say = await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'ควรคุยกับผู้ใช้ก่อน' })
    expect(say.statusCode).toBe(200)
    expect(say.json()).toMatchObject({ kind: 'opinion', text: 'ควรคุยกับผู้ใช้ก่อน', authorId: ba.id, optionKey: null })
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })).statusCode).toBe(200)
    expect((await call(dev, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a', text: 'เร็วกว่า' })).statusCode).toBe(200)
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'b' })).statusCode).toBe(200)
    const unknown = await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'zzz' })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json()).toEqual({ error: 'invalid_state' })
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote' })).statusCode).toBe(400)

    const mine = (await call(ba, 'GET', `/discussions/${d.id}`)).json() as Discussion
    expect(mine).toMatchObject({ voteCounts: { a: 1, b: 1 }, myVote: 'b', responseCount: 3 })
    expect(((await call(pm, 'GET', `/discussions/${d.id}`)).json() as Discussion).myVote).toBeNull()

    const list = (await call(pm, 'GET', `/discussions/${d.id}/responses`)).json() as DiscussionResponse[]
    expect(list.map((r) => [r.authorId, r.kind, r.optionKey])).toEqual([
      [ba.id, 'opinion', null],
      [dev.id, 'vote', 'a'],
      [ba.id, 'vote', 'b'],
    ])
    expect(list[1]).toMatchObject({ authorName: 'สมชาย', text: 'เร็วกว่า' })
  })

  it('a vote needs an option in a ready brief (none while the AI brief is pending)', async () => {
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'รอข้อมูล' })
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })).statusCode).toBe(422)
  })

  it('brief edits: raiser / PM / admin only; options become a ready person brief', async () => {
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง' })
    const edit = { context: 'บริบทของปัญหา', options: OPTIONS, recommendation: 'แนะนำ ข', recommendedKey: 'b' }
    expect((await call(ba, 'PUT', `/discussions/${d.id}/brief`, edit)).statusCode).toBe(403)
    const bad = await call(dev, 'PUT', `/discussions/${d.id}/brief`, { ...edit, recommendedKey: 'zzz' })
    expect(bad.statusCode).toBe(422)
    const ok = await call(dev, 'PUT', `/discussions/${d.id}/brief`, edit)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().brief).toEqual({ ...edit, source: 'person', status: 'ready', failReason: null })
    expect((await call(pm, 'PUT', `/discussions/${d.id}/brief`, { ...edit, recommendedKey: null })).statusCode).toBe(200)
    expect((await call(admin, 'PUT', `/discussions/${d.id}/brief`, edit)).statusCode).toBe(200)
  })

  it('a DEV-only member cannot decide; the PM decides in Thai and it becomes confirmed decision knowledge', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ควรใช้ระบบเดิมหรือสร้างใหม่?', options: OPTIONS, requestBrief: false })
    await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'ระบบเดิมพอใช้' })
    expect((await call(dev, 'POST', `/discussions/${d.id}/decide`, { decision: 'ใช้ระบบเดิม' })).statusCode).toBe(403)
    expect((await call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'x', optionKey: 'zzz' })).statusCode).toBe(422)

    const res = await call(pm, 'POST', `/discussions/${d.id}/decide`, {
      decision: 'ตัดสินใจใช้ระบบเดิมไปก่อนแล้วค่อยปรับปรุง',
      optionKey: 'a',
    })
    expect(res.statusCode, res.body).toBe(200)
    const decided = res.json() as Discussion
    expect(decided).toMatchObject({
      state: 'decided',
      decision: 'ตัดสินใจใช้ระบบเดิมไปก่อนแล้วค่อยปรับปรุง',
      decidedOptionKey: 'a',
      decidedById: pm.id,
      decidedByName: 'สมศรี',
    })
    expect(decided.decidedAt).not.toBeNull()

    const db = await testDb()
    const entries = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.type, 'decision'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      scope: 'work_item',
      projectId: p,
      workItemId: wi.id,
      status: 'confirmed',
      sourceKind: 'person',
      sourceRef: d.id,
      createdBy: pm.id,
      title: 'ควรใช้ระบบเดิมหรือสร้างใหม่?',
    })
    expect(entries[0]!.body).toContain('ตัดสินใจใช้ระบบเดิมไปก่อนแล้วค่อยปรับปรุง')
    expect(entries[0]!.body).toContain('ใช้ระบบเดิม')
    await drain()
    const hits = await searchKnowledge(db, asMe(dev, 'dev'), { query: 'ตัดสินใจใช้ระบบเดิม', projectId: p })
    expect(hits.map((h) => h.id)).toContain(entries[0]!.id)

    const types = (await db.select().from(events).where(eq(events.workItemId, wi.id))).map((e) => e.type)
    expect(types).toContain('discussion.decided')
    // Raiser and responders hear about it, once; the decider does not.
    expect((await discussionNotes(dev)).filter((n) => n.link === `/discussions/${d.id}`)).toHaveLength(1)
    expect(await discussionNotes(ba)).toHaveLength(1)
    expect((await discussionNotes(pm)).length).toBe(1) // only the "raised" one

    // Final: no more responses, edits, decisions or withdrawals.
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'สาย' })).statusCode).toBe(409)
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })).statusCode).toBe(409)
    expect(
      (await call(pm, 'PUT', `/discussions/${d.id}/brief`, { context: '', options: OPTIONS, recommendation: '', recommendedKey: null })).statusCode,
    ).toBe(409)
    expect((await call(pm2, 'POST', `/discussions/${d.id}/decide`, { decision: 'อีกครั้ง' })).statusCode).toBe(409)
    expect((await call(pm2, 'POST', `/discussions/${d.id}/withdraw`, { reason: 'x' })).statusCode).toBe(409)
  })

  it('two PMs deciding at once: one 200, one 409, one knowledge entry', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'พร้อมกัน', options: OPTIONS, requestBrief: false })
    const results = await Promise.all([
      call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'เลือก ก', optionKey: 'a' }),
      call(pm2, 'POST', `/discussions/${d.id}/decide`, { decision: 'เลือก ข', optionKey: 'b' }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const db = await testDb()
    expect(await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.type, 'decision'))).toHaveLength(1)
    expect(
      await db.select().from(events).where(and(eq(events.workItemId, wi.id), eq(events.type, 'discussion.decided'))),
    ).toHaveLength(1)
  })

  it('overlapping decide transactions: the second waits, then 409', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'พร้อมกัน', options: OPTIONS, requestBrief: false })
    let arrived = 0
    let release!: () => void
    const bothOpen = new Promise<void>((r) => (release = r))
    const decideAs = (who: Who, name: string) =>
      runWork(app.deps, { id: who.id, kind: 'person' }, async (ctx) => {
        if (++arrived === 2) release()
        await bothOpen
        return decideDiscussion(ctx, asMe(who, name), d.id, { decision: `โดย ${name}` })
      })
    const settled = await Promise.allSettled([decideAs(pm, 'pm'), decideAs(pm2, 'pm2')])
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected'])
    const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ statusCode: 409, body: { error: 'invalid_state' } })
    const db = await testDb()
    const [row] = await db.select().from(discussions).where(eq(discussions.id, d.id))
    expect(row!.state).toBe('decided')
    expect(await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.type, 'decision'))).toHaveLength(1)
  })

  it('withdraw: raiser / PM / admin; then deciding → 409', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ถอนได้ไหม' })
    expect((await call(ba, 'POST', `/discussions/${d.id}/withdraw`, { reason: 'ไม่จำเป็น' })).statusCode).toBe(403)
    expect((await call(dev, 'POST', `/discussions/${d.id}/withdraw`, {})).statusCode).toBe(400)
    const res = await call(dev, 'POST', `/discussions/${d.id}/withdraw`, { reason: 'ไม่จำเป็นแล้ว' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'withdrawn', decision: null })
    const db = await testDb()
    const [ev] = await db.select().from(events).where(and(eq(events.workItemId, wi.id), eq(events.type, 'discussion.withdrawn')))
    expect(ev).toMatchObject({ reason: 'ไม่จำเป็นแล้ว', actorId: dev.id })
    expect((await call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'สาย' })).statusCode).toBe(409)
    expect((await call(pm, 'POST', `/discussions/${d.id}/withdraw`, { reason: 'อีก' })).statusCode).toBe(409)

    // The raiser withdrawing their own discussion notifies nobody.
    expect((await discussionNotes(dev)).filter((n) => n.link === `/discussions/${d.id}`)).toEqual([])

    const d2 = await raise(dev, { workItemId: wi.id, question: 'PM ถอน', options: OPTIONS, requestBrief: false })
    await call(ba, 'POST', `/discussions/${d2.id}/responses`, { kind: 'vote', optionKey: 'a' })
    await call(pm2, 'POST', `/discussions/${d2.id}/responses`, { kind: 'opinion', text: 'ถอนได้' })
    expect((await call(pm, 'POST', `/discussions/${d2.id}/withdraw`, { reason: 'ซ้ำ' })).statusCode).toBe(200)
    const withdrawnNotes = async (who: Who) =>
      (await discussionNotes(who)).filter((n) => n.link === `/discussions/${d2.id}` && n.body === 'ซ้ำ')
    expect(await withdrawnNotes(dev)).toHaveLength(1)
    expect(await withdrawnNotes(ba)).toHaveLength(1)
    expect(await withdrawnNotes(pm2)).toHaveLength(1)
    expect(await withdrawnNotes(pm)).toEqual([])
    const d3 = await raise(dev, { workItemId: wi.id, question: 'admin ถอน' })
    expect((await call(admin, 'POST', `/discussions/${d3.id}/withdraw`, { reason: 'ซ้ำ' })).statusCode).toBe(200)
  })

  it('department discussions: any staff raises and sees them; only an admin decides', async () => {
    await project()
    const d = await raise(dev, { question: 'นโยบายแผนก: ใช้ AI กับข้อมูลผู้ป่วย?', options: OPTIONS, requestBrief: false })
    expect(d).toMatchObject({ projectId: null, projectName: null, workItemId: null, state: 'open' })
    // Admins (deciders) hear about it.
    expect(await discussionNotes(admin)).toHaveLength(1)
    expect(await discussionNotes(pm)).toEqual([])

    expect((await call(outsider, 'GET', `/discussions/${d.id}`)).statusCode).toBe(200)
    expect(((await call(outsider, 'GET', '/discussions')).json() as Discussion[]).map((x) => x.id)).toEqual([d.id])
    expect((await call(outsider, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'b' })).statusCode).toBe(200)
    expect((await call(nurse, 'GET', `/discussions/${d.id}`)).statusCode).toBe(403)
    expect((await call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'ไม่' })).statusCode).toBe(403)
    expect((await call(dev, 'POST', `/discussions/${d.id}/decide`, { decision: 'ไม่' })).statusCode).toBe(403)

    const res = await call(admin, 'POST', `/discussions/${d.id}/decide`, { decision: 'ไม่อนุญาตจนกว่าจะมีนโยบาย', optionKey: 'b' })
    expect(res.statusCode, res.body).toBe(200)
    const db = await testDb()
    const [entry] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.type, 'decision'))
    expect(entry).toMatchObject({ scope: 'department', projectId: null, workItemId: null, status: 'confirmed', createdBy: admin.id })
    expect(await discussionNotes(dev)).toHaveLength(1)
    expect(await discussionNotes(outsider)).toHaveLength(1)
  })

  it('department discussion live events reach staff only; project ones follow the project rule', async () => {
    const p = await project()
    const db = await testDb()
    const dept: LiveEvent = { type: 'discussion.raised', projectId: null, workItemId: null, taskId: null, conversationId: null, personId: null }
    expect(await deliverable(db, asMe(outsider, 'outsider'), dept)).toBe(true)
    expect(await deliverable(db, { ...asMe(nurse, 'nurse1'), isStaff: false }, dept)).toBe(false)
    const other: LiveEvent = { ...dept, type: 'work_item.created' }
    expect(await deliverable(db, asMe(outsider, 'outsider'), other)).toBe(false)
    const proj: LiveEvent = { ...dept, projectId: p }
    expect(await deliverable(db, asMe(outsider, 'outsider'), proj)).toBe(false)
    expect(await deliverable(db, asMe(dev, 'dev'), proj)).toBe(true)
  })

  it('a long question: the decision knowledge title is cut to 300 characters; the body keeps it whole', async () => {
    const p = await project()
    const question = `${'ก'.repeat(250)}${'ข'.repeat(250)}`
    expect(question).toHaveLength(500)
    const d = await raise(dev, { projectId: p, question, requestBrief: false })
    expect((await call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'ตกลง' })).statusCode).toBe(200)
    const db = await testDb()
    const [entry] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.sourceRef, d.id))
    expect(entry!.scope).toBe('project')
    expect([...entry!.title]).toHaveLength(300)
    expect(entry!.title.endsWith('…')).toBe(true)
    expect(entry!.title.startsWith('ก'.repeat(250))).toBe(true)
    expect(entry!.body).toContain(question)
  })

  it('permission is re-checked under the locks: a PM demoted while waiting gets 403', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ระหว่างรอ' })
    const db = await testDb()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked = false
    // Holds the work item lock while demoting the PM (uncommitted until released).
    const demotion = runWork(app.deps, { id: admin.id, kind: 'person' }, async (ctx) => {
      await lockItem(ctx.tx, wi.id)
      await ctx.tx
        .update(projectMembers)
        .set({ roles: ['DEV'] })
        .where(and(eq(projectMembers.projectId, p), eq(projectMembers.personId, pm.id)))
      locked = true
      await held
    })
    while (!locked) await new Promise((r) => setTimeout(r, 5))
    const decide = call(pm, 'POST', `/discussions/${d.id}/decide`, { decision: 'ตกลง' })
    let done = false
    void decide.finally(() => (done = true))
    for (let i = 0; i < 400 && !done; i++) {
      const rows = await db.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)
      if (rows.length > 0) break
      await new Promise((r) => setTimeout(r, 5))
    }
    release()
    await demotion
    expect((await decide).statusCode).toBe(403)
    const [row] = await db.select().from(discussions).where(eq(discussions.id, d.id))
    expect(row!.state).toBe('open')
  })

  it('lists open and scheduled discussions by priority, then oldest first; filters by state and project', async () => {
    const p = await project('Alpha')
    const q = await project('Beta')
    const low = await raise(dev, { projectId: p, question: 'ต่ำ', priority: 'low' })
    const urgent = await raise(dev, { projectId: q, question: 'ด่วน', priority: 'urgent' })
    const normal1 = await raise(dev, { projectId: p, question: 'ปกติ 1' })
    const normal2 = await raise(dev, { question: 'ปกติ 2 แผนก' })
    const gone = await raise(dev, { projectId: p, question: 'ถอนแล้ว' })
    expect((await call(dev, 'POST', `/discussions/${gone.id}/withdraw`, { reason: 'x' })).statusCode).toBe(200)

    const ids = async (who: Who, qs = '') => ((await call(who, 'GET', `/discussions${qs}`)).json() as Discussion[]).map((x) => x.id)
    expect(await ids(dev)).toEqual([urgent.id, normal1.id, normal2.id, low.id])
    expect(await ids(dev, `?projectId=${p}`)).toEqual([normal1.id, low.id])
    expect(await ids(dev, '?state=withdrawn')).toEqual([gone.id])
    expect(await ids(dev, '?sort=created')).toEqual([normal2.id, normal1.id, urgent.id, low.id])
    // Project name order (department, with no project, first), then priority and age.
    expect(await ids(dev, '?sort=project')).toEqual([normal2.id, normal1.id, low.id, urgent.id])
    expect(await ids(outsider)).toEqual([normal2.id])
    expect((await call(dev, 'GET', '/discussions?state=nope')).statusCode).toBe(400)
  })

  it('a work item lock does not block event inserts that reference the item (FK key-share)', async () => {
    const p = await project()
    const wi = await createItem(p)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked = false
    const holder = runWork(app.deps, { id: pm.id, kind: 'person' }, async (ctx) => {
      await lockItem(ctx.tx, wi.id)
      locked = true
      await held
    })
    while (!locked) await new Promise((r) => setTimeout(r, 5))
    // With FOR UPDATE on the item this insert would wait for the holder; lock_timeout turns a wait into an error.
    try {
      await runWork(app.deps, { id: dev.id, kind: 'person' }, async (ctx) => {
        await ctx.tx.execute(sql`set local lock_timeout = '2s'`)
        await recordEvent(ctx, { type: 'discussion.raised', projectId: p, workItemId: wi.id, taskId: null })
      })
    } finally {
      release()
      await holder
    }
  })

  it('discussion lock → event insert does not deadlock against work item lock → discussion lock', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'ล็อก', options: OPTIONS, requestBrief: false })
    let itemLocked!: () => void
    const itemHeld = new Promise<void>((r) => (itemLocked = r))
    let discussionLocked!: () => void
    const discussionHeld = new Promise<void>((r) => (discussionLocked = r))
    // A: as the brief settle / agenda put do — the discussion row, then an event referencing the work item.
    const a = runWork(app.deps, { id: null, kind: 'system' }, async (ctx) => {
      const row = await lockDiscussion(ctx.tx, d.id)
      discussionLocked()
      await itemHeld
      await recordDiscussionEvent(ctx, row, 'discussion.brief_failed', { reason: 'test' })
    })
    // B: as decide / withdraw do — the work item, then the discussion.
    const b = runWork(app.deps, { id: pm.id, kind: 'person' }, async (ctx) => {
      await discussionHeld
      await lockItem(ctx.tx, wi.id)
      itemLocked()
      await lockDiscussion(ctx.tx, d.id)
    })
    const settled = await Promise.allSettled([a, b])
    expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('decision knowledge: AI brief content goes under the unconfirmed heading; a person brief keeps its sections', async () => {
    const p = await project()
    const wi = await createItem(p)
    const db = await testDb()
    const ai = await raise(dev, { workItemId: wi.id, question: 'ควรใช้ระบบไหน?' })
    const aiBrief = {
      context: 'AI-CONTEXT บริบท',
      options: OPTIONS,
      recommendation: 'AI-RECOMMENDATION',
      recommendedKey: 'b',
      source: 'ai' as const,
      status: 'ready' as const,
      failReason: null,
    }
    await db.update(discussions).set({ brief: aiBrief }).where(eq(discussions.id, ai.id))
    expect((await call(pm, 'POST', `/discussions/${ai.id}/decide`, { decision: 'เลือกระบบเดิม', optionKey: 'a' })).statusCode).toBe(200)
    const [entry] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.sourceRef, ai.id))
    const body = entry!.body
    const heading = body.indexOf(`## ${AI_BRIEF_HEADING}`)
    expect(heading).toBeGreaterThan(0)
    expect(AI_BRIEF_HEADING).toBe('สรุปจาก AI (ยังไม่ได้ยืนยัน) / AI-prepared, unconfirmed')
    const confirmed = body.slice(0, heading)
    expect(confirmed).toContain('คำถาม: ควรใช้ระบบไหน?')
    expect(confirmed).toContain('ข้อสรุป: เลือกระบบเดิม')
    expect(confirmed).toContain('ทางเลือกที่เลือก: ใช้ระบบเดิม')
    expect(confirmed).not.toContain('AI-CONTEXT')
    expect(confirmed).not.toContain('AI-RECOMMENDATION')
    const unconfirmed = body.slice(heading)
    expect(unconfirmed).toContain('AI-CONTEXT')
    expect(unconfirmed).toContain('AI-RECOMMENDATION')
    expect(unconfirmed).toContain('- สร้างระบบใหม่ (แนะนำ)')
    expect(unconfirmed).toContain('ข้อดี: ยืดหยุ่น')

    const person = await raise(dev, { workItemId: wi.id, question: 'คนเขียนบทสรุป', options: OPTIONS, requestBrief: false })
    const edit = { context: 'PERSON-CONTEXT', options: OPTIONS, recommendation: 'PERSON-RECOMMENDATION', recommendedKey: 'a' }
    expect((await call(dev, 'PUT', `/discussions/${person.id}/brief`, edit)).statusCode).toBe(200)
    expect((await call(pm, 'POST', `/discussions/${person.id}/decide`, { decision: 'ตกลง' })).statusCode).toBe(200)
    const [pe] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.sourceRef, person.id))
    expect(pe!.body).toContain('บริบท: PERSON-CONTEXT')
    expect(pe!.body).toContain('ข้อเสนอแนะ: PERSON-RECOMMENDATION')
    expect(pe!.body).not.toContain(AI_BRIEF_HEADING)
  })

  it('a brief edit dropping an option deletes its votes and tells each voter once', async () => {
    const p = await project()
    const d = await raise(dev, { projectId: p, question: 'เลือกแนวทาง', options: OPTIONS, requestBrief: false })
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'b' })).statusCode).toBe(200)
    expect((await call(pm2, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })).statusCode).toBe(200)
    expect((await call(pm, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'b' })).statusCode).toBe(200)
    await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'ความเห็นยังอยู่' })
    const before = async (who: Who) => (await discussionNotes(who)).length
    const [ba0, pm20, pm0] = [await before(ba), await before(pm2), await before(pm)]

    // The PM drops option b (their own vote goes too, but they are the editor: not notified).
    const edit = { context: '', options: [OPTIONS[0]!, { key: 'c', title: 'ทางเลือกใหม่', pros: '', cons: '' }], recommendation: '', recommendedKey: null }
    const res = await call(pm, 'PUT', `/discussions/${d.id}/brief`, edit)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ voteCounts: { a: 1 } })
    const db = await testDb()
    const rows = await db.select().from(discussionResponses).where(eq(discussionResponses.discussionId, d.id))
    expect(rows.map((r) => [r.authorId, r.kind, r.optionKey]).sort()).toEqual(
      [[ba.id, 'opinion', null], [pm2.id, 'vote', 'a']].sort(),
    )
    const baNotes = await discussionNotes(ba)
    expect(baNotes).toHaveLength(ba0 + 1)
    expect(baNotes.find((n) => n.title.includes('ทางเลือกที่คุณโหวตถูกเปลี่ยน'))).toMatchObject({ link: `/discussions/${d.id}` })
    expect(await before(pm2)).toBe(pm20)
    expect(await before(pm)).toBe(pm0)
    // The same edit again removes nothing and tells nobody.
    expect((await call(pm, 'PUT', `/discussions/${d.id}/brief`, edit)).statusCode).toBe(200)
    expect(await discussionNotes(ba)).toHaveLength(ba0 + 1)
    // A later reset is a new notification for the same voter.
    expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'c' })).statusCode).toBe(200)
    expect((await call(pm, 'PUT', `/discussions/${d.id}/brief`, { ...edit, options: [OPTIONS[0]!] })).statusCode).toBe(200)
    expect(await discussionNotes(ba)).toHaveLength(ba0 + 2)
  })

  it('a response pushes a live-only discussion.responded event to the project', async () => {
    const p = await project()
    const wi = await createItem(p)
    const d = await raise(dev, { workItemId: wi.id, question: 'สด', options: OPTIONS, requestBrief: false })
    const seen: LiveEvent[] = []
    const off = app.deps.bus.subscribe((e) => void seen.push(e))
    try {
      expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'opinion', text: 'เห็นด้วย' })).statusCode).toBe(200)
      expect((await call(ba, 'POST', `/discussions/${d.id}/responses`, { kind: 'vote', optionKey: 'a' })).statusCode).toBe(200)
    } finally {
      off()
    }
    const responded = seen.filter((e) => e.type === 'discussion.responded')
    expect(responded).toHaveLength(2)
    expect(responded[0]).toMatchObject({ projectId: p, workItemId: wi.id, personId: null })
    expect(await deliverable(await testDb(), asMe(outsider, 'outsider'), responded[0]!)).toBe(false)
    expect(await deliverable(await testDb(), asMe(dev, 'dev'), responded[0]!)).toBe(true)
    // Live-only: never stored.
    const db = await testDb()
    expect(await db.select().from(events).where(eq(events.type, 'discussion.responded'))).toHaveLength(0)

    // A department discussion: pushed with no project (all staff).
    const dept = await raise(dev, { question: 'แผนก', options: OPTIONS, requestBrief: false })
    const seen2: LiveEvent[] = []
    const off2 = app.deps.bus.subscribe((e) => void seen2.push(e))
    try {
      expect((await call(ba, 'POST', `/discussions/${dept.id}/responses`, { kind: 'opinion', text: 'ok' })).statusCode).toBe(200)
    } finally {
      off2()
    }
    expect(seen2.filter((e) => e.type === 'discussion.responded')).toEqual([
      { type: 'discussion.responded', projectId: null, workItemId: null, taskId: null, conversationId: null, personId: null },
    ])
  })
})
