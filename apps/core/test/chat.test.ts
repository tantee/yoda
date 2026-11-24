import type { FastifyInstance } from 'fastify'
import type { Attachment, Conversation, Message, TaskWithContext, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { attachments, messages } from '../src/db/schema.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let ba: Who
let outsider: Who
let nurse: Who
let nurse2: Who

const NO_ID = '00000000-0000-4000-8000-000000000000'
const NOT_READY = 'ผู้ช่วยยังไม่พร้อมใช้งาน'

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

function multipart(file: { name: string; type: string; data: Buffer }): { payload: Buffer; headers: Record<string, string> } {
  const b = '----yodaChatBoundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${b}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
}

const uploadTo = (who: Who, conversationId: string, file = { name: 'ตัวอย่าง.txt', type: 'text/plain', data: Buffer.from('ตัวอย่างผลแล็บ') }) => {
  const m = multipart(file)
  return app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/attachments`,
    headers: { ...auth(who), ...m.headers },
    payload: m.payload,
  })
}

async function project(members: [Who, string[]][]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

const personal = async (who: Who): Promise<Conversation> => {
  const res = await call(who, 'GET', '/conversations/personal')
  expect(res.statusCode).toBe(200)
  return res.json()
}
const post = (who: Who, conversationId: string, body: Record<string, unknown>) =>
  call(who, 'POST', `/conversations/${conversationId}/messages`, body)
const list = async (who: Who): Promise<Conversation[]> => (await call(who, 'GET', '/conversations')).json()

describe('conversations and messages', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    ba = await login(app, 'ba', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1', { name: 'พยาบาลหนึ่ง' })
    nurse2 = await login(app, 'nurse2')
  })
  afterEach(async () => {
    await app.close()
  })

  it('a requester gets one intake conversation; staff get a personal one', async () => {
    const c = await personal(nurse)
    expect(c).toMatchObject({ kind: 'intake', ownerId: nurse.id, ownerName: 'พยาบาลหนึ่ง', projectId: null, workItemId: null, title: 'ผู้ช่วย', unread: 0 })
    expect((await personal(nurse)).id).toBe(c.id)
    const [a, b] = await Promise.all([personal(nurse2), personal(nurse2)])
    expect(a.id).toBe(b.id)
    expect((await personal(pm)).kind).toBe('personal')
    expect((await list(nurse)).map((x) => x.id)).toEqual([c.id])
  })

  it('posting returns the message; others get 404 on the conversation', async () => {
    const c = await personal(nurse)
    const res = await post(nurse, c.id, { text: 'ขอรายงานแล็บใหม่' })
    expect(res.statusCode).toBe(201)
    const m = res.json() as Message
    expect(m).toMatchObject({ conversationId: c.id, authorKind: 'person', authorId: nurse.id, authorName: 'พยาบาลหนึ่ง', text: 'ขอรายงานแล็บใหม่', attachments: [], actions: [] })
    expect((await list(nurse))[0]!.lastMessageAt).not.toBeNull()

    for (const who of [nurse2, outsider, pm]) {
      expect((await call(who, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(404)
      expect((await post(who, c.id, { text: 'x' })).statusCode).toBe(404)
      expect((await call(who, 'POST', `/conversations/${c.id}/read`, { seq: m.seq })).statusCode).toBe(404)
      expect((await uploadTo(who, c.id)).statusCode).toBe(404)
      expect((await list(who)).map((x) => x.id)).not.toContain(c.id)
    }
    expect((await call(nurse, 'GET', `/conversations/${NO_ID}/messages`)).statusCode).toBe(404)
    expect((await post(nurse, c.id, { text: '   ' })).statusCode).toBe(400)
  })

  it('project threads: staff members only; requesters cannot create threads', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    expect((await call(outsider, 'POST', '/conversations', { kind: 'project', projectId: p })).statusCode).toBe(404)
    expect((await call(nurse, 'POST', '/conversations', { kind: 'project', projectId: p })).statusCode).toBe(403)
    const res = await call(pm, 'POST', '/conversations', { kind: 'project', projectId: p, title: 'ทีม' })
    expect(res.statusCode).toBe(201)
    const c = res.json() as Conversation
    expect(c).toMatchObject({ kind: 'project', projectId: p, workItemId: null, title: 'ทีม', ownerId: pm.id })
    expect((await post(ba, c.id, { text: 'สวัสดี' })).statusCode).toBe(201)
    expect((await call(ba, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(200)
    expect((await call(admin, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(200)
    expect((await list(ba)).map((x) => x.id)).toContain(c.id)
    for (const who of [outsider, nurse]) {
      expect((await call(who, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(404)
      expect((await list(who)).map((x) => x.id)).not.toContain(c.id)
    }
  })

  it('work-item threads: members and the requester; project must match the item', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const p2 = await project([[pm, ['PM']]])
    const wi = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'รายงาน', templateKey: 'software-change', requesterId: nurse.id })).json() as WorkItemDetail
    expect((await call(pm, 'POST', '/conversations', { kind: 'work_item', projectId: p2, workItemId: wi.id })).statusCode).toBe(404)
    expect((await call(outsider, 'POST', '/conversations', { kind: 'work_item', workItemId: wi.id })).statusCode).toBe(404)
    const res = await call(pm, 'POST', '/conversations', { kind: 'work_item', workItemId: wi.id })
    expect(res.statusCode).toBe(201)
    const c = res.json() as Conversation
    expect(c).toMatchObject({ kind: 'work_item', projectId: p, workItemId: wi.id, title: 'รายงาน' })
    expect((await call(nurse, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(200)
    expect((await list(nurse)).map((x) => x.id)).toContain(c.id)
    expect((await call(nurse2, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/conversations/${c.id}/messages`)).statusCode).toBe(404)
  })

  it('attachments: from this conversation or its project only', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const p2 = await project([[pm, ['PM']]])
    const thread = (await call(pm, 'POST', '/conversations', { kind: 'project', projectId: p })).json() as Conversation
    const db = await testDb()
    const file = async (projectId: string | null, over: Record<string, unknown> = {}) =>
      (
        await db
          .insert(attachments)
          .values({ projectId, storageKey: `k-${Math.random()}`, fileName: 'f.txt', contentType: 'text/plain', sizeBytes: 1, uploadedBy: pm.id, ...over })
          .returning()
      )[0]!
    const other = await file(p2)
    expect((await post(pm, thread.id, { text: 'x', attachmentIds: [other.id] })).statusCode).toBe(404)
    expect((await post(pm, thread.id, { text: 'x', attachmentIds: [NO_ID] })).statusCode).toBe(404)
    const own = await file(p)
    const ok = await post(pm, thread.id, { text: 'ดูไฟล์นี้', attachmentIds: [own.id] })
    expect(ok.statusCode).toBe(201)
    expect((ok.json() as Message).attachments.map((a) => a.id)).toEqual([own.id])

    // A personal conversation's file can't be posted elsewhere, and a project file can't go into a personal thread.
    const mine = await personal(pm)
    const up = (await uploadTo(pm, mine.id)).json() as Attachment
    expect((await post(pm, thread.id, { text: 'x', attachmentIds: [up.id] })).statusCode).toBe(404)
    expect((await post(pm, mine.id, { text: 'x', attachmentIds: [own.id] })).statusCode).toBe(404)
    expect((await post(pm, mine.id, { text: 'x', attachmentIds: [up.id] })).statusCode).toBe(201)
    const nothing = await db.select().from(messages).where(eq(messages.conversationId, thread.id))
    expect(nothing).toHaveLength(1)
  })

  it('requester uploads to the intake conversation; download is limited to who can see it', async () => {
    const c = await personal(nurse)
    const data = Buffer.from('ตัวอย่างผลแล็บ', 'utf8')
    const res = await uploadTo(nurse, c.id, { name: 'ตัวอย่าง.txt', type: 'text/plain', data })
    expect(res.statusCode).toBe(201)
    const a = res.json() as Attachment
    expect(a).toMatchObject({ projectId: null, conversationId: c.id, fileName: 'ตัวอย่าง.txt', hasText: true, uploadedById: nurse.id })
    expect((await uploadTo(nurse, c.id, { name: 'a.exe', type: 'application/x-msdownload', data: Buffer.from('MZ') })).statusCode).toBe(415)

    const dl = await call(nurse, 'GET', `/conversations/${c.id}/attachments/${a.id}/download`)
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.equals(data)).toBe(true)
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('ตัวอย่าง.txt')}`)
    expect((await call(nurse2, 'GET', `/conversations/${c.id}/attachments/${a.id}/download`)).statusCode).toBe(404)
    const c2 = await personal(nurse2)
    expect((await call(nurse2, 'GET', `/conversations/${c2.id}/attachments/${a.id}/download`)).statusCode).toBe(404)
    // No project → not reachable through the project download route either.
    expect((await call(admin, 'GET', `/attachments/${a.id}/download`)).statusCode).toBe(404)
  })

  it('pages older messages with before, ascending; unread drops to 0 after read', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const c = (await call(pm, 'POST', '/conversations', { kind: 'project', projectId: p })).json() as Conversation
    const posted: Message[] = []
    for (let i = 1; i <= 5; i++) posted.push((await post(pm, c.id, { text: `m${i}` })).json())
    const page = (await call(ba, 'GET', `/conversations/${c.id}/messages?limit=2`)).json() as Message[]
    expect(page.map((m) => m.text)).toEqual(['m4', 'm5'])
    const older = (await call(ba, 'GET', `/conversations/${c.id}/messages?limit=2&before=${page[0]!.seq}`)).json() as Message[]
    expect(older.map((m) => m.text)).toEqual(['m2', 'm3'])
    const all = (await call(ba, 'GET', `/conversations/${c.id}/messages`)).json() as Message[]
    expect(all.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])

    const unread = async (who: Who) => (await list(who)).find((x) => x.id === c.id)!.unread
    expect(await unread(ba)).toBe(5)
    expect(await unread(pm)).toBe(0) // own messages are never unread
    expect((await call(ba, 'POST', `/conversations/${c.id}/read`, { seq: posted[2]!.seq })).statusCode).toBe(204)
    expect(await unread(ba)).toBe(2)
    expect((await call(ba, 'POST', `/conversations/${c.id}/read`, { seq: posted[4]!.seq })).statusCode).toBe(204)
    expect(await unread(ba)).toBe(0)
    // Reading backwards never raises the count again.
    await call(ba, 'POST', `/conversations/${c.id}/read`, { seq: posted[0]!.seq })
    expect(await unread(ba)).toBe(0)
  })
})

describe('interim secretary reply', () => {
  let jobs: InlineJobQueue
  beforeEach(async () => {
    await resetDb(await testDb())
    jobs = new InlineJobQueue({ onError: (err) => console.warn(err) })
    app = await makeApp({ jobs })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('answers each person message with one system message', async () => {
    const c = await personal(nurse)
    await post(nurse, c.id, { text: 'สวัสดี' })
    await jobs.drain()
    const msgs = (await call(nurse, 'GET', `/conversations/${c.id}/messages`)).json() as Message[]
    expect(msgs.map((m) => [m.authorKind, m.text])).toEqual([
      ['person', 'สวัสดี'],
      ['system', NOT_READY],
    ])
    expect(msgs[1]!.authorId).toBeNull()
    expect((await call(nurse, 'GET', '/conversations')).json()[0].unread).toBe(1)
  })
})

describe('requester samples from the intake conversation', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    ba = await login(app, 'ba', { staff: true })
    nurse = await login(app, 'nurse1')
    nurse2 = await login(app, 'nurse2')
  })
  afterEach(async () => {
    await app.close()
  })

  async function answerTask(): Promise<{ projectId: string; workItemId: string; taskId: string }> {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const wi = (await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'รายงาน', templateKey: 'software-change', requesterId: nurse.id })).json() as WorkItemDetail
    const step = async (key: string, who: Who, result: Record<string, unknown>) => {
      const d = (await call(pm, 'GET', `/work-items/${wi.id}`)).json() as WorkItemDetail
      const t = d.tasks.filter((x) => x.templateTaskKey === key).at(-1)!
      if (t.assigneeId !== who.id) await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })
      expect((await call(who, 'POST', `/tasks/${t.id}/submit`, result)).statusCode).toBe(200)
    }
    await step('accept-intake', pm, { text: '', decision: 'approve' })
    await step('draft-requirements', ba, { text: 'คำถาม' })
    const d = (await call(pm, 'GET', `/work-items/${wi.id}`)).json() as WorkItemDetail
    const answer = d.tasks.find((x) => x.templateTaskKey === 'answer-questions')!
    expect(answer.assigneeId).toBe(nurse.id)
    return { projectId: p, workItemId: wi.id, taskId: answer.id }
  }

  it('links the requester’s own intake upload; another requester’s upload → 404', async () => {
    const { projectId, workItemId, taskId } = await answerTask()
    const other = (await uploadTo(nurse2, (await personal(nurse2)).id)).json() as Attachment
    const bad = await call(nurse, 'POST', `/tasks/${taskId}/submit`, { text: 'คำตอบ', attachmentIds: [other.id] })
    expect(bad.statusCode).toBe(404)

    const mine = (await uploadTo(nurse, (await personal(nurse)).id)).json() as Attachment
    const ok = await call(nurse, 'POST', `/tasks/${taskId}/submit`, { text: 'คำตอบ', attachmentIds: [mine.id] })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as TaskWithContext).attachments.map((a) => a.id)).toEqual([mine.id])
    const db = await testDb()
    const [row] = await db.select().from(attachments).where(eq(attachments.id, mine.id))
    expect(row).toMatchObject({ projectId, workItemId, taskId })
    const [untouched] = await db.select().from(attachments).where(eq(attachments.id, other.id))
    expect(untouched).toMatchObject({ projectId: null, workItemId: null, taskId: null })
  })
})
