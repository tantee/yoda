import type { Attachment, Conversation, Message, Proposal, WorkItemDetail } from '@yoda/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../src/ai/gateway.js'
import { aiCalls, departmentSettings, events, knowledgeEntries, messages, proposals, workItems } from '../src/db/schema.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { secretaryChat } from '../src/secretary/chat.js'
import { turnStream } from './ai-mocks.js'
import { mockModels, resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

type Turn = { text?: string; toolCalls?: { name: string; input: unknown }[] }

let app: FastifyInstance
let jobs: InlineJobQueue
let model: MockLanguageModelV4
let script: (Turn | 'fail')[] = []
let step = 0
let admin: Who
let pm: Who
let dev: Who
let outsider: Who
let nurse: Who
let nurse2: Who

/** The model plays `turns` in order (the last repeats); `'fail'` makes that call throw (a provider error). */
function play(...turns: (Turn | 'fail')[]) {
  script = turns
  step = 0
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(name: string, members: [Who, string[]][]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function doc(who: Who, projectId: string, title: string, body: string): Promise<string> {
  const res = await call(who, 'POST', '/knowledge', { scope: 'project', projectId, type: 'document', title, body })
  expect(res.statusCode).toBe(201)
  return res.json().id
}

const personal = async (who: Who): Promise<Conversation> => (await call(who, 'GET', '/conversations/personal')).json()

async function say(who: Who, conversationId: string, text: string, attachmentIds: string[] = []): Promise<Message> {
  const res = await call(who, 'POST', `/conversations/${conversationId}/messages`, { text, attachmentIds })
  expect(res.statusCode).toBe(201)
  await jobs.drain()
  return res.json()
}

const thread = async (who: Who, conversationId: string): Promise<Message[]> =>
  (await call(who, 'GET', `/conversations/${conversationId}/messages`)).json()

/** Everything the model was sent, across all calls (system prompt, history, tool results). */
const sent = () => JSON.stringify(model.doStreamCalls.map((c) => c.prompt))
/** Tool results the model saw in its last call. */
function lastToolOutputs(): string {
  const prompt = model.doStreamCalls.at(-1)!.prompt
  return JSON.stringify(prompt.filter((m) => m.role === 'tool'))
}

function upload(who: Who, conversationId: string, name = 'ผลแล็บ.txt'): Promise<Attachment> {
  const b = '----yodaSecretaryBoundary'
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('ค่าน้ำตาล 180'),
    Buffer.from(`\r\n--${b}--\r\n`),
  ])
  return app
    .inject({
      method: 'POST',
      url: `/conversations/${conversationId}/attachments`,
      headers: { ...auth(who), 'content-type': `multipart/form-data; boundary=${b}` },
      payload,
    })
    .then((r) => {
      expect(r.statusCode).toBe(201)
      return r.json()
    })
}

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  play({ text: 'ok' })
  model = new MockLanguageModelV4({
    modelId: 'claude-haiku-5-5',
    doStream: async () => {
      const turn = script[Math.min(step++, script.length - 1)]!
      if (turn === 'fail') throw new Error('upstream down')
      return { stream: turnStream(turn) }
    },
  })
  jobs = new InlineJobQueue({ onError: (err, name, id) => console.warn(`job ${name} ${id} failed`, err) })
  const ai = new AiGateway({ db, bus: new LiveBus(), models: mockModels({ fast: model }), config: { dailyTaskCap: 8 } })
  app = await makeApp({ jobs, ai })
  admin = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true, name: 'คุณพีเอ็ม' })
  dev = await login(app, 'dev', { staff: true, name: 'คุณเดฟ' })
  outsider = await login(app, 'outsider', { staff: true })
  nurse = await login(app, 'nurse1', { name: 'พยาบาลหนึ่ง' })
  nurse2 = await login(app, 'nurse2')
})

afterEach(async () => {
  await app.close()
})

describe('secretary chat: staff', () => {
  it('answers a personal-thread question from the project document found with search_knowledge', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    await doc(dev, p, 'คู่มือค่าแล็บ', 'ค่า HbA1c ปกติต้องต่ำกว่า 5.7 เปอร์เซ็นต์')
    play(
      { toolCalls: [{ name: 'search_knowledge', input: { query: 'HbA1c' } }] },
      { text: 'ตามคู่มือค่าแล็บ ค่า HbA1c ปกติต้องต่ำกว่า 5.7 เปอร์เซ็นต์' },
    )
    const c = await personal(dev)
    await say(dev, c.id, 'ค่า HbA1c ปกติเท่าไหร่')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(lastToolOutputs()).toContain('ต่ำกว่า 5.7')
    const msgs = await thread(dev, c.id)
    expect(msgs.map((m) => m.authorKind)).toEqual(['person', 'ai'])
    expect(msgs[1]!.text).toContain('5.7')
    expect(msgs[1]!.authorId).toBeNull()
    // Department-billed (personal thread); one fast call.
    const rows = await (await testDb()).select().from(aiCalls)
    expect(rows.filter((r) => r.job === 'fast')).toMatchObject([{ projectId: null, ok: true }])
    // The person's own system prompt names them and their project.
    const system = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!
    expect(JSON.stringify(system)).toContain('ระบบแล็บ')
  })

  it('propose_work_item creates one pending proposal on behalf of the person with a proposal card, no work item', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    play(
      {
        toolCalls: [
          {
            name: 'propose_work_item',
            input: { projectId: p, title: 'แก้รายงานช้า', description: 'หน้ารายงานโหลดนาน', templateKey: 'bug-fix', priority: 'high' },
          },
        ],
      },
      { text: 'เตรียมข้อเสนอสร้างงานไว้แล้ว กรุณายืนยัน' },
    )
    const c = await personal(dev)
    await say(dev, c.id, 'ช่วยเปิดงานแก้รายงานช้าให้หน่อย')
    const db = await testDb()
    const rows = await db.select().from(proposals)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'create_work_item',
      state: 'pending',
      projectId: p,
      onBehalfOf: dev.id,
      createdByKind: 'ai',
    })
    expect(rows[0]!.payload).toMatchObject({ projectId: p, title: 'แก้รายงานช้า', templateKey: 'bug-fix', priority: 'high' })
    expect(await db.select().from(workItems)).toHaveLength(0)
    const msgs = await thread(dev, c.id)
    expect(msgs.at(-1)).toMatchObject({ authorKind: 'ai', actions: [{ type: 'proposal', proposalId: rows[0]!.id }] })
    // The event records the AI acting for the person.
    const [ev] = await db.select().from(events).where(eq(events.type, 'proposal.created'))
    expect(ev).toMatchObject({ actorKind: 'ai', actorId: dev.id })
    expect(ev!.payload).toMatchObject({ onBehalfOf: dev.id })
    // The person can confirm it themselves.
    const decided = await call(dev, 'POST', `/proposals/${rows[0]!.id}/decide`, { decision: 'accept' })
    expect(decided.statusCode).toBe(200)
  })

  it('proposing into a project the person is not a member of → tool error relayed, nothing created', async () => {
    const p = await project('โครงการลับ', [[pm, ['PM']]])
    play(
      {
        toolCalls: [
          { name: 'propose_work_item', input: { projectId: p, title: 'งานใหม่', description: '', templateKey: 'bug-fix', priority: 'normal' } },
        ],
      },
      { text: 'ขออภัย คุณไม่ได้เป็นสมาชิกโครงการนั้น' },
    )
    const c = await personal(outsider)
    await say(outsider, c.id, 'สร้างงานในโครงการลับให้หน่อย')
    const tool = lastToolOutputs()
    expect(tool).toContain('error-text')
    expect(tool).toContain('not a member')
    expect(tool).not.toContain(p)
    expect(await (await testDb()).select().from(proposals)).toHaveLength(0)
    const msgs = await thread(outsider, c.id)
    expect(msgs.at(-1)).toMatchObject({ authorKind: 'ai', text: 'ขออภัย คุณไม่ได้เป็นสมาชิกโครงการนั้น', actions: [] })
  })

  it('cannot read another project’s knowledge', async () => {
    const p = await project('โครงการอื่น', [[pm, ['PM']]])
    await doc(pm, p, 'สเปกภายใน', 'รหัสลับ ZEBRA-77 ของโครงการอื่น')
    play(
      { toolCalls: [{ name: 'search_knowledge', input: { query: 'ZEBRA-77', projectId: p } }, { name: 'search_knowledge', input: { query: 'ZEBRA-77' } }, { name: 'project_status', input: { projectId: p } }] },
      { text: 'ไม่พบ' },
    )
    const c = await personal(dev)
    await say(dev, c.id, 'ZEBRA-77 คืออะไร')
    expect(lastToolOutputs()).not.toContain('รหัสลับ')
    expect(sent()).not.toContain('รหัสลับ')
    expect(sent()).not.toContain('สเปกภายใน')
  })

  it('a noAi project’s documents never reach any prompt or tool result; its thread gets no_ai without a model call', async () => {
    const secret = await project('โครงการปิด', [[pm, ['PM']], [dev, ['DEV']]])
    await doc(dev, secret, 'บันทึกปิด', 'ข้อมูลผู้ป่วย VIP-9931 ห้ามส่ง')
    expect((await call(admin, 'PATCH', `/projects/${secret}`, { noAi: true })).statusCode).toBe(200)
    const wi = (await call(pm, 'POST', `/projects/${secret}/work-items`, { title: 'งานปิด VIP', templateKey: 'bug-fix' })).json() as WorkItemDetail
    play(
      {
        toolCalls: [
          { name: 'search_knowledge', input: { query: 'VIP-9931' } },
          { name: 'search_knowledge', input: { query: 'VIP-9931', projectId: secret } },
          { name: 'project_status', input: { projectId: secret } },
          { name: 'work_item', input: { workItemId: wi.id } },
          { name: 'my_todo', input: {} },
        ],
      },
      { text: 'ไม่สามารถเข้าถึงได้' },
    )
    const c = await personal(dev)
    await say(dev, c.id, 'VIP-9931 คืออะไร')
    const all = sent()
    expect(all).not.toContain('VIP-9931 ห้ามส่ง')
    expect(all).not.toContain('บันทึกปิด')
    expect(all).not.toContain('งานปิด VIP')
    expect(all).not.toContain('โครงการปิด')
    expect(lastToolOutputs()).toContain('not available to the assistant')

    const calls = model.doStreamCalls.length
    const t = (await call(dev, 'POST', '/conversations', { kind: 'project', projectId: secret })).json() as Conversation
    await say(dev, t.id, '@ai สรุปให้หน่อย')
    expect(model.doStreamCalls).toHaveLength(calls)
    expect((await thread(dev, t.id)).at(-1)).toMatchObject({ authorKind: 'system', text: '[[secretary.failed:no_ai]]' })
  })

  it('project threads: no reply without @ai; with @ai the reply is billed to the project', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    const t = (await call(dev, 'POST', '/conversations', { kind: 'project', projectId: p })).json() as Conversation
    await say(dev, t.id, 'ทีม ช่วยดูหน่อย')
    expect(model.doStreamCalls).toHaveLength(0)
    expect((await thread(dev, t.id)).map((m) => m.authorKind)).toEqual(['person'])

    play({ text: 'สรุป: ยังไม่มีงาน' })
    await say(pm, t.id, '@AI ช่วยสรุปสถานะ')
    expect(model.doStreamCalls).toHaveLength(1)
    expect((await thread(dev, t.id)).map((m) => [m.authorKind, m.text])).toEqual([
      ['person', 'ทีม ช่วยดูหน่อย'],
      ['person', '@AI ช่วยสรุปสถานะ'],
      ['ai', 'สรุป: ยังไม่มีงาน'],
    ])
    const rows = await (await testDb()).select().from(aiCalls)
    expect(rows).toMatchObject([{ projectId: p, job: 'fast', ok: true }])
    // The earlier team message is context for the reply.
    expect(sent()).toContain('ทีม ช่วยดูหน่อย')
  })

  it('a work_item thread @ผู้ช่วย mention gets the work item context', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    const wi = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'ปรับหน้ารายงาน', templateKey: 'bug-fix' })).json() as WorkItemDetail
    const t = (await call(dev, 'POST', '/conversations', { kind: 'work_item', workItemId: wi.id })).json() as Conversation
    play({ text: 'งานนี้อยู่ขั้นแรก' })
    await say(dev, t.id, '@ผู้ช่วย งานนี้ถึงไหนแล้ว')
    expect(sent()).toContain('ปรับหน้ารายงาน')
    expect((await thread(dev, t.id)).at(-1)).toMatchObject({ authorKind: 'ai', text: 'งานนี้อยู่ขั้นแรก' })
  })

  it('staff who are only the requester of a work item get the requester view of its thread', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    const wi = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'คำขอของคนนอก', templateKey: 'bug-fix', requesterId: outsider.id })).json() as WorkItemDetail
    const t = (await call(pm, 'POST', '/conversations', { kind: 'work_item', workItemId: wi.id })).json() as Conversation
    play({ text: 'คำขอของคุณได้รับแล้ว' })
    await say(outsider, t.id, '@ai ถึงไหนแล้ว')
    expect(sent()).toContain('คำขอของคนนอก')
    expect((await thread(outsider, t.id)).at(-1)).toMatchObject({ authorKind: 'ai', text: 'คำขอของคุณได้รับแล้ว' })
  })

  it('propose_priority: a proposal in propose projects; applied directly (as the person) in auto-assign projects', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    const wi = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'งาน A', templateKey: 'bug-fix' })).json() as WorkItemDetail
    play({ toolCalls: [{ name: 'propose_priority', input: { workItemId: wi.id, priority: 'urgent', reason: 'ผู้ใช้รอ' } }] }, { text: 'เสนอแล้ว' })
    const c = await personal(dev)
    await say(dev, c.id, 'งาน A ด่วน')
    const db = await testDb()
    const [prop] = await db.select().from(proposals)
    expect(prop).toMatchObject({ kind: 'priority_change', workItemId: wi.id, onBehalfOf: dev.id, state: 'pending' })
    expect((await thread(dev, c.id)).at(-1)!.actions).toEqual([{ type: 'proposal', proposalId: prop!.id }])
    expect((await db.select().from(workItems).where(eq(workItems.id, wi.id)))[0]!.priority).toBe('normal')

    expect((await call(admin, 'PATCH', `/projects/${p}`, { autonomy: 'auto-assign' })).statusCode).toBe(200)
    play({ toolCalls: [{ name: 'propose_priority', input: { workItemId: wi.id, priority: 'high', reason: 'ผู้ใช้รอ' } }] }, { text: 'ปรับแล้ว' })
    await say(dev, c.id, 'ปรับเป็นสูง')
    expect((await db.select().from(workItems).where(eq(workItems.id, wi.id)))[0]!.priority).toBe('high')
    const changed = await db
      .select()
      .from(events)
      .where(and(eq(events.workItemId, wi.id), eq(events.type, 'work_item.priority_changed')))
    expect(changed).toMatchObject([{ actorKind: 'ai', actorId: dev.id, payload: { from: 'normal', to: 'high', onBehalfOf: dev.id } }])
    expect(await db.select().from(proposals)).toHaveLength(1)
  })

  it('save_note saves a draft AI knowledge entry with a knowledge_saved card', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    play({ toolCalls: [{ name: 'save_note', input: { projectId: p, type: 'fact', title: 'เซิร์ฟเวอร์แล็บ', body: 'ใช้ PostgreSQL 16' } }] }, { text: 'บันทึกแล้ว' })
    const c = await personal(dev)
    await say(dev, c.id, 'จดไว้ว่าเซิร์ฟเวอร์แล็บใช้ PostgreSQL 16')
    const [e] = await (await testDb()).select().from(knowledgeEntries)
    expect(e).toMatchObject({ projectId: p, type: 'fact', status: 'draft', sourceKind: 'ai', createdBy: dev.id })
    expect((await thread(dev, c.id)).at(-1)!.actions).toEqual([{ type: 'knowledge_saved', entryId: e!.id, title: 'เซิร์ฟเวอร์แล็บ' }])
  })
})

describe('secretary chat: requesters', () => {
  it('submit_request creates a project-less proposal on behalf of the requester, visible to admins', async () => {
    const c = await personal(nurse)
    const file = await upload(nurse, c.id)
    play(
      { toolCalls: [{ name: 'submit_request', input: { title: 'ระบบแล็บช้า', description: 'เปิดผลแล็บนานมาก', attachmentIds: [file.id] } }] },
      { text: 'ส่งคำขอให้ทีมแล้ว รอการยืนยัน' },
    )
    await say(nurse, c.id, 'ระบบแล็บช้ามาก', [file.id])
    const db = await testDb()
    const rows = await db.select().from(proposals)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'create_work_item', projectId: null, onBehalfOf: nurse.id, createdByKind: 'ai', state: 'pending' })
    expect(rows[0]!.payload).toMatchObject({ title: 'ระบบแล็บช้า', attachmentIds: [file.id] })
    expect((await thread(nurse, c.id)).at(-1)).toMatchObject({ authorKind: 'ai', actions: [{ type: 'proposal', proposalId: rows[0]!.id }] })
    const listed = (await call(admin, 'GET', '/proposals?state=pending')).json() as Proposal[]
    expect(listed.map((p) => p.id)).toEqual([rows[0]!.id])
  })

  it('submit_request with another requester’s upload is refused; nothing created', async () => {
    const other = await upload(nurse2, (await personal(nurse2)).id)
    play(
      { toolCalls: [{ name: 'submit_request', input: { title: 'ขอดูไฟล์', description: '', attachmentIds: [other.id] } }] },
      { text: 'แนบไฟล์นั้นไม่ได้' },
    )
    const c = await personal(nurse)
    await say(nurse, c.id, 'ส่งคำขอพร้อมไฟล์')
    expect(lastToolOutputs()).toContain('error-text')
    expect(lastToolOutputs()).not.toContain(other.id)
    expect(await (await testDb()).select().from(proposals)).toHaveLength(0)
  })

  it('requesters only get requester tools and see only their own requests, without staff names', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    const mine = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'คำขอของพยาบาลหนึ่ง', templateKey: 'bug-fix', requesterId: nurse.id })).json() as WorkItemDetail
    const theirs = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'คำขอของคนอื่น', templateKey: 'bug-fix', requesterId: nurse2.id })).json() as WorkItemDetail
    play(
      {
        toolCalls: [
          { name: 'my_requests', input: {} },
          { name: 'request_status', input: { workItemId: mine.id } },
          { name: 'request_status', input: { workItemId: theirs.id } },
          { name: 'search_knowledge', input: { query: 'แล็บ' } },
        ],
      },
      { text: 'คำขอของคุณกำลังดำเนินการ' },
    )
    const c = await personal(nurse)
    await say(nurse, c.id, 'คำขอของฉันถึงไหนแล้ว')
    const tools = model.doStreamCalls[0]!.tools?.map((t) => t.name).sort()
    expect(tools).toEqual(['my_requests', 'request_status', 'submit_request'])
    const out = lastToolOutputs()
    expect(out).toContain('คำขอของพยาบาลหนึ่ง')
    expect(out).not.toContain('คำขอของคนอื่น')
    expect(sent()).not.toContain('คุณพีเอ็ม')
    expect(sent()).not.toContain('คุณเดฟ')
    expect((await thread(nurse, c.id)).at(-1)).toMatchObject({ authorKind: 'ai' })
  })
})

describe('secretary chat: failures', () => {
  it('department budget exhausted → budget_exceeded marker and no model call', async () => {
    const db = await testDb()
    await db.update(departmentSettings).set({ aiBudgetUsd: '0.01' }).where(eq(departmentSettings.id, 1))
    await db.insert(aiCalls).values({ projectId: null, job: 'fast', ok: true, costUsd: '0.010000' })
    const c = await personal(dev)
    await say(dev, c.id, 'สวัสดี')
    expect(model.doStreamCalls).toHaveLength(0)
    expect((await thread(dev, c.id)).map((m) => [m.authorKind, m.text])).toEqual([
      ['person', 'สวัสดี'],
      ['system', '[[secretary.failed:budget_exceeded]]'],
    ])
  })

  it('malformed tool input → tool error, the conversation still gets a reply', async () => {
    play({ toolCalls: [{ name: 'propose_work_item', input: { title: 5 } }] }, { text: 'ขอข้อมูลเพิ่มเติมก่อนนะ' })
    const c = await personal(dev)
    await say(dev, c.id, 'สร้างงาน')
    expect(lastToolOutputs()).toContain('error')
    expect(await (await testDb()).select().from(proposals)).toHaveLength(0)
    expect((await thread(dev, c.id)).at(-1)).toMatchObject({ authorKind: 'ai', text: 'ขอข้อมูลเพิ่มเติมก่อนนะ' })
  })

  it('provider failure after a tool call → ai_failed marker and no half-applied tool effects', async () => {
    const p = await project('ระบบแล็บ', [[pm, ['PM']], [dev, ['DEV']]])
    play(
      { toolCalls: [{ name: 'propose_work_item', input: { projectId: p, title: 'งาน', description: '', templateKey: 'bug-fix', priority: 'normal' } }] },
      'fail',
    )
    const c = await personal(dev)
    await say(dev, c.id, 'สร้างงาน')
    expect(await (await testDb()).select().from(proposals)).toHaveLength(0)
    expect((await thread(dev, c.id)).map((m) => [m.authorKind, m.text])).toEqual([
      ['person', 'สร้างงาน'],
      ['system', '[[secretary.failed:ai_failed]]'],
    ])
  })

  it('no fast model configured → ai_unavailable', async () => {
    await app.close()
    const db = await testDb()
    const ai = new AiGateway({
      db,
      bus: new LiveBus(),
      models: mockModels({ fast: null, ids: { draft: 'anthropic:claude-opus-5-5', fast: null, embed: null } }),
      config: { dailyTaskCap: 8 },
    })
    jobs = new InlineJobQueue()
    app = await makeApp({ jobs, ai })
    const c = await personal(dev)
    await say(dev, c.id, 'สวัสดี')
    expect((await thread(dev, c.id)).at(-1)).toMatchObject({ authorKind: 'system', text: '[[secretary.failed:ai_unavailable]]' })
  })

  it('duplicate job delivery → one reply, one model run', async () => {
    const c = await personal(dev)
    const m = await say(dev, c.id, 'สวัสดี')
    expect(model.doStreamCalls).toHaveLength(1)
    await secretaryChat(app.deps, { id: m.id, attempt: 1, isFinalAttempt: true })
    await secretaryChat(app.deps, { id: m.id, attempt: 2, isFinalAttempt: true })
    expect(model.doStreamCalls).toHaveLength(1)
    const rows = await (await testDb()).select().from(messages).where(eq(messages.conversationId, c.id))
    expect(rows.map((r) => r.authorKind)).toEqual(['person', 'ai'])
  })
})
