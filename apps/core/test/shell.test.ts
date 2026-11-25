import type { FastifyInstance } from 'fastify'
import type { Conversation, SearchResult, Todo, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let dev: Who
let outsider: Who
let nurse: Who
let nurse2: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(name: string, members: [Who, string[]][] = [[pm, ['PM']], [dev, ['DEV']]]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string, title: string, body: Record<string, unknown> = {}): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title, templateKey: 'software-change', ...body })
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

const counts = async (who: Who) => {
  const res = await call(who, 'GET', '/me/counts')
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as Record<string, number>
}

const search = async (who: Who, q: string) => {
  const res = await call(who, 'GET', `/search?q=${encodeURIComponent(q)}`)
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as SearchResult[]
}

beforeEach(async () => {
  await resetDb(await testDb())
  app = await makeApp()
  admin = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true, name: 'สมศรี ใจดี' })
  dev = await login(app, 'dev', { staff: true, name: 'สมชาย นักพัฒนา' })
  outsider = await login(app, 'outsider', { staff: true, name: 'คนนอก' })
  nurse = await login(app, 'nurse1', { name: 'พยาบาลหนึ่ง' })
  nurse2 = await login(app, 'nurse2', { name: 'พยาบาลสอง' })
})
afterEach(async () => {
  await app.close()
})

describe('GET /me/counts', () => {
  it('staff: to-do matches the to-do list, chat counts unread threads, discussions those awaiting a response', async () => {
    const p = await project('ระบบนัดหมาย')
    await createItem(p, 'แจ้งเตือนนัดผ่าน SMS')

    const todo = (await call(pm, 'GET', '/me/todo')).json() as Todo
    const total = todo.tasks.length + todo.confirmations.length + todo.proposals.length + todo.awaitingAdvance.length
    expect(total).toBeGreaterThan(0)
    expect(await counts(pm)).toEqual({ todo: total, chat: 0, discussions: 0 })

    // A project thread with a message from the PM: unread for the dev, not for the PM.
    const conv = (await call(pm, 'POST', '/conversations', { kind: 'project', projectId: p })).json() as Conversation
    expect((await call(pm, 'POST', `/conversations/${conv.id}/messages`, { text: 'ประชุมพรุ่งนี้' })).statusCode).toBe(201)
    expect((await counts(dev)).chat).toBe(1)
    expect((await counts(pm)).chat).toBe(0)
    expect((await counts(outsider)).chat).toBe(0)

    // Discussions: open ones you can see and have not responded to yet.
    const d = await call(dev, 'POST', '/discussions', {
      projectId: p,
      question: 'ใช้ผู้ให้บริการ SMS รายไหน',
      options: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }],
      requestBrief: false,
    })
    expect(d.statusCode, d.body).toBe(201)
    const dept = await call(dev, 'POST', '/discussions', { question: 'ย้ายห้องประชุม', requestBrief: false })
    expect(dept.statusCode, dept.body).toBe(201)
    expect((await counts(pm)).discussions).toBe(2)
    // The project discussion is hidden from non-members; the department one is not.
    expect((await counts(outsider)).discussions).toBe(1)
    const vote = await call(pm, 'POST', `/discussions/${d.json().id}/responses`, { kind: 'vote', optionKey: 'a' })
    expect(vote.statusCode, vote.body).toBe(200)
    expect((await counts(pm)).discussions).toBe(1)
  })

  it('requester: only their own requests and questions, no staff counts', async () => {
    const p = await project('ระบบแล็บ')
    await createItem(p, 'รายงานแล็บรายวัน', { requesterId: nurse.id })
    await createItem(p, 'รายงานแล็บรายเดือน', { requesterId: nurse.id })
    await createItem(p, 'ของคนอื่น', { requesterId: nurse2.id })

    const mine = await counts(nurse)
    expect(Object.keys(mine).sort()).toEqual(['answers', 'requests'])
    expect(mine).toEqual({ requests: 2, answers: 0 })
    expect(await counts(nurse2)).toEqual({ requests: 1, answers: 0 })
  })

  it('needs a signed-in user', async () => {
    expect((await app.inject({ url: '/me/counts' })).statusCode).toBe(401)
  })
})

describe('GET /search', () => {
  it('staff find projects, work items and staff people they may see; at most 10', async () => {
    const p = await project('ระบบนัดหมายผู้ป่วยนอก')
    const hidden = await project('ระบบนัดหมายลับ', [[outsider, ['PM']]])
    const wi = await createItem(p, 'นัดหมายผ่าน LINE')

    const hits = await search(dev, 'นัดหมาย')
    expect(hits.map((h) => [h.type, h.id])).toEqual(
      expect.arrayContaining([['project', p], ['work_item', wi.id]]),
    )
    expect(hits.find((h) => h.id === hidden)).toBeUndefined()
    expect(hits.find((h) => h.id === wi.id)).toMatchObject({ title: 'นัดหมายผ่าน LINE', subtitle: 'ระบบนัดหมายผู้ป่วยนอก', route: `/work-items/${wi.id}` })
    expect(hits.find((h) => h.id === p)).toMatchObject({ route: `/projects/${p}` })

    // Admins see every project.
    expect((await search(admin, 'นัดหมาย')).map((h) => h.id)).toContain(hidden)

    // Staff people by name or username; requesters are never listed.
    const people = await search(dev, 'สม')
    expect(people.filter((h) => h.type === 'person').map((h) => h.id).sort()).toEqual([pm.id, dev.id].sort())
    expect((await search(dev, 'พยาบาล')).filter((h) => h.type === 'person')).toEqual([])
    expect((await search(dev, 'nurse')).filter((h) => h.type === 'person')).toEqual([])

    for (let i = 0; i < 12; i++) await createItem(p, `นัดหมายงานที่ ${i}`)
    expect((await search(dev, 'นัดหมาย')).length).toBe(10)
  })

  it('treats LIKE wildcards literally', async () => {
    const p = await project('ระบบ A')
    await createItem(p, 'ลด 50% ค่าบริการ')
    await createItem(p, 'อื่นๆ')
    expect((await search(dev, '%%')).map((h) => h.title)).toEqual([])
    expect((await search(dev, '50%')).map((h) => h.title)).toEqual(['ลด 50% ค่าบริการ'])
  })

  it('requesters find only their own requests: no other requests, projects or staff people', async () => {
    const p = await project('ระบบแล็บ')
    const own = await createItem(p, 'รายงานแล็บของฉัน', { requesterId: nurse.id })
    const other = await createItem(p, 'รายงานแล็บของคนอื่น', { requesterId: nurse2.id })
    await createItem(p, 'รายงานแล็บภายใน')

    const hits = await search(nurse, 'แล็บ')
    expect(hits).toEqual([
      { type: 'request', id: own.id, title: 'รายงานแล็บของฉัน', subtitle: 'ระบบแล็บ', route: `/requests/${own.id}` },
    ])
    expect((await search(nurse2, 'แล็บ')).map((h) => h.id)).toEqual([other.id])
    expect(await search(nurse, 'สม')).toEqual([])
    expect(await search(nurse, 'ระบบ')).toEqual([])
  })

  it('needs at least 2 characters', async () => {
    expect((await call(dev, 'GET', '/search?q=a')).statusCode).toBe(400)
    expect((await call(dev, 'GET', '/search?q=%20%20a%20')).statusCode).toBe(400)
    expect((await call(dev, 'GET', '/search')).statusCode).toBe(400)
  })
})
