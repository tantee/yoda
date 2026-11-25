import type { FastifyInstance } from 'fastify'
import type { Agenda, Discussion } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { discussions, events } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let dev: Who
let outsider: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(name: string, members: [Who, string[]][]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function raise(who: Who, body: Record<string, unknown>): Promise<Discussion> {
  const res = await call(who, 'POST', '/discussions', { requestBrief: false, ...body })
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}

const MEETING = '2099-01-15T09:00:00+07:00'
async function agenda(who = pm): Promise<Agenda> {
  const res = await call(who, 'POST', '/agendas', { title: 'ประชุมแผนก', meetingAt: MEETING })
  expect(res.statusCode, res.body).toBe(201)
  return res.json()
}
const put = (who: Who, id: string, ids: string[]) => call(who, 'PUT', `/agendas/${id}/items`, { discussionIds: ids })
const state = async (id: string) => (await call(admin, 'GET', `/discussions/${id}`)).json() as Discussion

describe('agendas', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('GET /agendas/permissions: admins and PMs of any project may edit; other staff not; requesters 403', async () => {
    const can = async (who: Who) => {
      const res = await call(who, 'GET', '/agendas/permissions')
      expect(res.statusCode, res.body).toBe(200)
      return (res.json() as { canEdit: boolean }).canEdit
    }
    expect(await can(admin)).toBe(true)
    expect(await can(pm)).toBe(false)
    const p = await project('ก', [[pm, ['PM']], [admin, ['PM']], [dev, ['DEV']]])
    expect(await can(pm)).toBe(true)
    expect(await can(dev)).toBe(false)
    expect(await can(outsider)).toBe(false)
    expect((await call(nurse, 'GET', '/agendas/permissions')).statusCode).toBe(403)
    // Losing the PM role takes the right away at once (the admin stays the project's PM).
    expect((await call(admin, 'PUT', `/projects/${p}/members/${pm.id}`, { roles: ['DEV'] })).statusCode).toBe(200)
    expect(await can(pm)).toBe(false)
  })

  it('a PM schedules three discussions in order, reorders, removes one, deletes the agenda', async () => {
    const p = await project('ก', [[pm, ['PM']], [dev, ['DEV']]])
    const [a, b, c] = [await raise(pm, { projectId: p, question: 'คำถาม ก' }), await raise(dev, { projectId: p, question: 'คำถาม ข' }), await raise(pm, { question: 'ระดับแผนก' })] as [Discussion, Discussion, Discussion]
    const ag = await agenda()
    expect(ag).toMatchObject({ title: 'ประชุมแผนก', createdById: pm.id, items: [] })

    let res = await put(pm, ag.id, [a.id, b.id, c.id])
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as Agenda).items.map((i) => [i.discussionId, i.position, i.state])).toEqual([
      [a.id, 0, 'scheduled'],
      [b.id, 1, 'scheduled'],
      [c.id, 2, 'scheduled'],
    ])
    expect((await state(a.id)).agendaId).toBe(ag.id)
    const db = await testDb()
    expect(await db.select().from(events).where(and(eq(events.projectId, p), eq(events.type, 'discussion.scheduled')))).toHaveLength(2)

    // Reorder: no new scheduled events for ones already here.
    res = await put(pm, ag.id, [c.id, a.id, b.id])
    expect((res.json() as Agenda).items.map((i) => i.discussionId)).toEqual([c.id, a.id, b.id])
    expect(await db.select().from(events).where(and(eq(events.projectId, p), eq(events.type, 'discussion.scheduled')))).toHaveLength(2)

    // Remove one.
    res = await put(pm, ag.id, [c.id, b.id])
    expect((res.json() as Agenda).items.map((i) => [i.discussionId, i.position])).toEqual([[c.id, 0], [b.id, 1]])
    expect(await state(a.id)).toMatchObject({ state: 'open', agendaId: null })

    // Decide b, delete the agenda: c back to open, b stays decided.
    expect((await call(pm, 'POST', `/discussions/${b.id}/decide`, { decision: 'ตกลง' })).statusCode).toBe(200)
    expect((await call(pm, 'DELETE', `/agendas/${ag.id}`)).statusCode).toBe(204)
    expect(await state(c.id)).toMatchObject({ state: 'open', agendaId: null })
    expect(await state(b.id)).toMatchObject({ state: 'decided', agendaId: null })
    expect((await call(pm, 'GET', `/agendas/${ag.id}`)).statusCode).toBe(404)
  })

  it('moving a discussion to another agenda; decided or unknown discussions are refused', async () => {
    const p = await project('ก', [[pm, ['PM']]])
    const a = await raise(pm, { projectId: p, question: 'ก' })
    const b = await raise(pm, { projectId: p, question: 'ข' })
    const ag1 = await agenda()
    const ag2 = await agenda()
    await put(pm, ag1.id, [a.id])
    const res = await put(pm, ag2.id, [a.id])
    expect((res.json() as Agenda).items.map((i) => i.discussionId)).toEqual([a.id])
    expect(((await call(pm, 'GET', `/agendas/${ag1.id}`)).json() as Agenda).items).toEqual([])
    expect(await state(a.id)).toMatchObject({ state: 'scheduled', agendaId: ag2.id })

    await call(pm, 'POST', `/discussions/${b.id}/decide`, { decision: 'x' })
    const bad = await put(pm, ag2.id, [a.id, b.id])
    expect(bad.statusCode).toBe(422)
    expect(await state(a.id)).toMatchObject({ state: 'scheduled', agendaId: ag2.id })
    expect((await put(pm, ag2.id, ['00000000-0000-4000-8000-000000000000'])).statusCode).toBe(404)
    expect((await put(pm, ag2.id, [a.id, a.id])).statusCode).toBe(422)
  })

  it('a DEV-only member views but cannot edit; requesters get 403', async () => {
    const p = await project('ก', [[pm, ['PM']], [dev, ['DEV']]])
    const d = await raise(pm, { projectId: p, question: 'ก' })
    const ag = await agenda()
    await put(pm, ag.id, [d.id])
    expect((await call(dev, 'GET', `/agendas/${ag.id}`)).json().items).toHaveLength(1)
    expect((await call(dev, 'GET', '/agendas?upcoming=true')).json()).toHaveLength(1)
    expect((await call(dev, 'POST', '/agendas', { title: 'x', meetingAt: MEETING })).statusCode).toBe(403)
    expect((await put(dev, ag.id, [])).statusCode).toBe(403)
    expect((await call(dev, 'DELETE', `/agendas/${ag.id}`)).statusCode).toBe(403)
    expect((await put(outsider, ag.id, [])).statusCode).toBe(403)
    for (const [m, u] of [['GET', '/agendas'], ['GET', `/agendas/${ag.id}`]] as const) {
      expect((await call(nurse, m, u)).statusCode).toBe(403)
    }
    expect((await call(nurse, 'POST', '/agendas', { title: 'x', meetingAt: MEETING })).statusCode).toBe(403)
    expect((await put(nurse, ag.id, [])).statusCode).toBe(403)
    expect((await call(nurse, 'DELETE', `/agendas/${ag.id}`)).statusCode).toBe(403)
    // Admin may edit; a past meeting is not "upcoming".
    expect((await put(admin, ag.id, [])).statusCode).toBe(200)
    const past = await call(admin, 'POST', '/agendas', { title: 'เก่า', meetingAt: '2020-01-01T00:00:00Z' })
    expect(past.statusCode).toBe(201)
    expect((await call(admin, 'GET', '/agendas?upcoming=true')).json()).toHaveLength(1)
    expect((await call(admin, 'GET', '/agendas')).json()).toHaveLength(2)
  })

  it('a staff member outside project B sees the agenda without its item; editing keeps hidden items', async () => {
    const pa = await project('A', [[pm, ['PM']], [outsider, ['DEV']]])
    const pb = await project('B', [[pm, ['PM']]])
    const outPm = await login(app, 'outpm', { staff: true })
    expect((await call(admin, 'PUT', `/projects/${pa}/members/${outPm.id}`, { roles: ['PM'] })).statusCode).toBe(200)
    const da = await raise(pm, { projectId: pa, question: 'A' })
    const db_ = await raise(pm, { projectId: pb, question: 'B' })
    const ag = await agenda()
    await put(pm, ag.id, [da.id, db_.id])
    expect((await call(outsider, 'GET', `/agendas/${ag.id}`)).json().items.map((i: { discussionId: string }) => i.discussionId)).toEqual([da.id])
    expect((await call(outsider, 'GET', '/agendas')).json()[0].items).toHaveLength(1)
    // A PM who cannot see B: cannot list B's discussion (404); removing A leaves B's item untouched.
    expect((await put(outPm, ag.id, [db_.id])).statusCode).toBe(404)
    expect((await put(outPm, ag.id, [])).statusCode).toBe(200)
    expect(await state(da.id)).toMatchObject({ state: 'open', agendaId: null })
    expect(await state(db_.id)).toMatchObject({ state: 'scheduled', agendaId: ag.id })
  })

  it('a discussion decided between the check and the lock is refused and nothing changes', async () => {
    const p = await project('ก', [[pm, ['PM']]])
    const a = await raise(pm, { projectId: p, question: 'ก' })
    const b = await raise(pm, { projectId: p, question: 'ข' })
    const ag = await agenda()
    const [r1, r2] = await Promise.all([
      call(pm, 'POST', `/discussions/${b.id}/decide`, { decision: 'ตกลง' }),
      put(pm, ag.id, [a.id, b.id]),
    ])
    expect(r1.statusCode).toBe(200)
    if (r2.statusCode === 422) {
      expect(await state(a.id)).toMatchObject({ state: 'open', agendaId: null })
    } else {
      // Agenda won the lock first; the decision then applied on a scheduled discussion.
      expect(r2.statusCode).toBe(200)
    }
    expect(await state(b.id)).toMatchObject({ state: 'decided' })
    const db = await testDb()
    expect((await db.select().from(discussions).where(eq(discussions.id, b.id)))[0]!.state).toBe('decided')
  })
})
