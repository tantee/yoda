import type { FastifyInstance } from 'fastify'
import type { LiveEvent, Notification, Task, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { events, notifications } from '../src/db/schema.js'
import { createProposal } from '../src/proposals/service.js'
import { runWork } from '../src/work/context.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let pm2: Who
let dev: Who
let qc: Who
let nurse: Who
let nurse2: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(members: [Who, string[]][], autonomy: 'propose' | 'auto-assign' = 'propose'): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  if (autonomy !== 'propose') expect((await call(pm, 'PATCH', `/projects/${id}`, { autonomy })).statusCode).toBe(200)
  return id
}

async function createItem(projectId: string, body: Record<string, unknown> = {}): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
    title: 'แก้รายงานผิดพลาด',
    templateKey: 'bug-fix',
    ...body,
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const detail = async (id: string): Promise<WorkItemDetail> => (await call(pm, 'GET', `/work-items/${id}`)).json()
const active = async (itemId: string, key: string): Promise<Task | undefined> =>
  (await detail(itemId)).tasks.filter((t) => t.templateTaskKey === key).at(-1)
const inbox = async (who: Who, unread = false): Promise<Notification[]> =>
  (await call(who, 'GET', `/me/notifications${unread ? '?unread=true' : ''}`)).json()

async function drive(itemId: string, key: string, who: Who, result: Record<string, unknown> = { text: 'ok' }) {
  const t = (await active(itemId, key))!
  if (t.assigneeId !== who.id) {
    expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  }
  expect((await call(who, 'POST', `/tasks/${t.id}/submit`, result)).statusCode).toBe(200)
  await acceptStepAdvance(app, pm, itemId)
}

const approve = { text: '', decision: 'approve' }

/** A bug fix up to the requester's delivery check. */
async function toDelivery(requester: Who): Promise<string> {
  const p = await project([[pm, ['PM']], [pm2, ['PM']], [dev, ['DEV']], [qc, ['QC']]])
  const wi = await createItem(p, { requesterId: requester.id })
  await drive(wi.id, 'accept-bug', pm, approve)
  await drive(wi.id, 'implement', dev, { text: 'x' })
  await drive(wi.id, 'draft-tests', qc, { text: 't' })
  await drive(wi.id, 'review-code', dev, approve)
  await drive(wi.id, 'verify', qc, { text: 'ok' })
  await drive(wi.id, 'approve-release', qc, approve)
  return wi.id
}

describe('daily task cap', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    dev = await login(app, 'dev', { staff: true })
  })
  afterEach(async () => {
    await app.close()
  })

  it('auto-assigns at most 8 intake tasks to the only PM; the rest wait for the PM', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]], 'auto-assign')
    const items: WorkItemDetail[] = []
    for (let i = 0; i < 10; i++) items.push(await createItem(p, { title: `บั๊ก ${i}` }))
    const intake = items.map((w) => w.tasks.find((t) => t.templateTaskKey === 'accept-bug')!)
    const assigned = intake.filter((t) => t.assigneeId === pm.id)
    const waiting = intake.filter((t) => t.assigneeId === null)
    expect(assigned).toHaveLength(8)
    expect(waiting).toHaveLength(2)
    expect(waiting.every((t) => t.state === 'open' && t.proposedAssigneeId === null)).toBe(true)

    const db = await testDb()
    const created = await db
      .select()
      .from(events)
      .where(and(eq(events.type, 'task.created'), eq(events.reason, 'daily_cap')))
    expect(created.map((e) => e.taskId).sort()).toEqual(waiting.map((t) => t.id).sort())
    const marked = await db.select().from(events).where(eq(events.type, 'task.assigned'))
    expect(marked.every((e) => (e.payload as { auto?: boolean }).auto === true)).toBe(true)

    // The waiting tasks are in the PM's confirmations, and a manual assignment ignores the cap.
    const todo = (await call(pm, 'GET', '/me/todo')).json() as { confirmations: { id: string }[] }
    expect(todo.confirmations.map((t) => t.id).sort()).toEqual(waiting.map((t) => t.id).sort())
    for (const t of waiting) {
      expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
    }
    expect((await detail(items[9]!.id)).tasks[0]!.assigneeId).toBe(pm.id)
    // Manual assignments are not automatic ones: they do not count towards the cap.
    const autoCount = (await db.select().from(events).where(eq(events.type, 'task.assigned'))).filter(
      (e) => (e.payload as { auto?: boolean }).auto,
    )
    expect(autoCount).toHaveLength(8)
  })
})

describe('notifications', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    pm2 = await login(app, 'pm2', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    qc = await login(app, 'qc', { staff: true })
    nurse = await login(app, 'nurse1')
    nurse2 = await login(app, 'nurse2')
  })
  afterEach(async () => {
    await app.close()
  })

  it('does not duplicate task_assigned when the same task is assigned to the same person again', async () => {
    const p = await project([[pm, ['PM']], [dev, ['PM', 'DEV']]])
    const wi = await createItem(p)
    const t = wi.tasks[0]!
    expect(await inbox(dev)).toEqual([])
    for (let i = 0; i < 3; i++) {
      expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
    }
    const mine = await inbox(dev)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ kind: 'task_assigned', readAt: null, link: `/todo/${t.id}` })
    expect(mine[0]!.title).toContain('รับเรื่องเข้าระบบ')
    expect(mine[0]!.body).toBe('แก้รายงานผิดพลาด')
    // Handing it to someone else notifies them; assigning yourself does not notify you.
    expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
    expect(await inbox(pm)).toEqual([])
  })

  it('confirming a proposed assignment notifies the new assignee once', async () => {
    const p = await project([[pm, ['PM']], [dev, ['PM']]])
    const wi = await createItem(p)
    const t = wi.tasks[0]!
    expect(t).toMatchObject({ state: 'proposed' })
    const confirmer = t.proposedAssigneeId === pm.id ? dev : pm
    const proposed = t.proposedAssigneeId === pm.id ? pm : dev
    expect((await call(confirmer, 'POST', `/tasks/${t.id}/confirm`)).statusCode).toBe(200)
    expect((await inbox(proposed)).filter((n) => n.kind === 'task_assigned')).toHaveLength(1)
  })

  it('proposals notify the project PMs only, once each; project-less ones notify admins', async () => {
    const p = await project([[pm, ['PM']], [pm2, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(p)
    expect((await call(pm, 'POST', `/tasks/${wi.tasks[0]!.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
    expect((await call(pm, 'POST', `/tasks/${wi.tasks[0]!.id}/submit`, approve)).statusCode).toBe(200)
    const db = await testDb()
    const rows = await db.select().from(notifications).where(eq(notifications.kind, 'proposal_pending'))
    expect(rows.map((r) => r.personId).sort()).toEqual([pm.id, pm2.id].sort())
    expect(rows.every((r) => /^proposal:[0-9a-f-]{36}$/.test(r.dedupeKey!))).toBe(true)
    expect(await inbox(dev)).toEqual([])
    const pending = (await inbox(pm2)).filter((n) => n.kind === 'proposal_pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.body).toContain('แก้รายงานผิดพลาด')
  })

  it('project-less proposals notify every admin and every PM of any project, once each', async () => {
    // pm is PM of two projects and an admin is also a PM: each person is notified once.
    await project([[pm, ['PM']], [dev, ['DEV']]])
    await project([[pm, ['PM']], [pm2, ['PM']], [admin, ['PM']], [qc, ['QC']]])
    const id = await runWork(app.deps, { id: null, kind: 'ai' }, (ctx) =>
      createProposal(ctx, {
        projectId: null,
        workItemId: null,
        kind: 'create_work_item',
        summary: 'แจ้งปัญหา',
        reason: '',
        payload: { title: 'รายงานช้า', description: '', templateKey: 'bug-fix', priority: 'normal' },
        onBehalfOf: nurse.id,
      }),
    )
    const db = await testDb()
    const rows = await db.select().from(notifications).where(eq(notifications.kind, 'proposal_pending'))
    expect(rows.map((r) => r.personId).sort()).toEqual([admin.id, pm.id, pm2.id].sort())
    expect(rows.every((r) => r.dedupeKey === `proposal:${id}`)).toBe(true)
    // Not the requester it was made for, nor staff who are not PMs.
    expect(await inbox(dev)).toEqual([])
    expect(await inbox(qc)).toEqual([])
    expect(await inbox(nurse)).toEqual([])
  })

  it('marking read: by ids, then all; others ids are ignored; bad bodies are 400', async () => {
    const p = await project([[pm, ['PM']], [dev, ['PM', 'DEV']]])
    for (let i = 0; i < 3; i++) {
      const wi = await createItem(p, { title: `บั๊ก ${i}` })
      expect((await call(pm, 'POST', `/tasks/${wi.tasks[0]!.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
    }
    const all = await inbox(dev)
    expect(all).toHaveLength(3)
    expect((await inbox(dev, true)).map((n) => n.id).sort()).toEqual(all.map((n) => n.id).sort())

    const first = all[0]!.id
    expect((await call(dev, 'POST', '/me/notifications/read', { ids: [first] })).json()).toEqual({ updated: 1 })
    expect((await inbox(dev, true)).map((n) => n.id)).not.toContain(first)
    expect((await inbox(dev)).find((n) => n.id === first)!.readAt).not.toBeNull()
    // A stranger cannot read someone else's notification.
    expect((await call(qc, 'POST', '/me/notifications/read', { ids: [all[1]!.id] })).json()).toEqual({ updated: 0 })
    expect(await inbox(dev, true)).toHaveLength(2)

    expect((await call(dev, 'POST', '/me/notifications/read', { all: true })).json()).toEqual({ updated: 2 })
    expect(await inbox(dev, true)).toEqual([])
    expect(await inbox(dev)).toHaveLength(3)
    for (const bad of [{}, { ids: [] }, { ids: ['nope'] }, { all: false }]) {
      expect((await call(dev, 'POST', '/me/notifications/read', bad)).statusCode).toBe(400)
    }
    expect((await app.inject({ url: '/me/notifications' })).statusCode).toBe(401)
  })

  it('returns the newest 50', async () => {
    const db = await testDb()
    for (let i = 0; i < 55; i++) {
      await db.insert(notifications).values({ personId: dev.id, kind: 'secretary_message', title: `n${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })
    }
    const list = await inbox(dev)
    expect(list).toHaveLength(50)
    expect(list[0]!.title).toBe('n54')
  })

  it('a requester sees only their own request_update notifications', async () => {
    const wiId = await toDelivery(nurse)
    const mine = await inbox(nurse)
    expect(mine.map((n) => n.kind)).toEqual(['request_update'])
    expect(mine[0]).toMatchObject({ link: `/todo/${(await active(wiId, 'accept-delivery'))!.id}` })
    expect(await inbox(nurse2)).toEqual([])

    // The requester asks for changes: the PMs (not the requester, not other staff) are told, once per task.
    const accept = (await active(wiId, 'accept-delivery'))!
    expect((await call(nurse, 'POST', `/tasks/${accept.id}/submit`, { text: 'ปุ่มยังไม่ทำงาน', decision: 'changes' })).statusCode).toBe(200)
    for (const who of [pm, pm2]) {
      const n = (await inbox(who)).filter((x) => x.kind === 'request_update')
      expect(n).toHaveLength(1)
      expect(n[0]!.body).toBe('ปุ่มยังไม่ทำงาน')
    }
    expect((await inbox(dev)).filter((x) => x.kind === 'request_update')).toEqual([])
    // The reopened delivery check (a new attempt) asks them again; they never see the PMs' notifications.
    expect((await inbox(nurse)).map((n) => n.kind)).toEqual(['request_update', 'request_update'])
    expect((await call(nurse, 'POST', '/me/notifications/read', { all: true })).json()).toEqual({ updated: 2 })
  })

  it('the requester is told when the request is done or cancelled', async () => {
    const wiId = await toDelivery(nurse)
    const accept = (await active(wiId, 'accept-delivery'))!
    expect((await call(nurse, 'POST', `/tasks/${accept.id}/submit`, { text: '', decision: 'approve' })).statusCode).toBe(200)
    await acceptStepAdvance(app, pm, wiId)
    await drive(wiId, 'close-bug', pm, approve)
    expect((await detail(wiId)).state).toBe('done')
    const done = (await inbox(nurse)).filter((n) => n.title.includes('เสร็จ'))
    expect(done).toHaveLength(1)
    expect(done[0]!.link).toBe('/requests')

    const p2 = await project([[pm, ['PM']]])
    const other = await createItem(p2, { requesterId: nurse2.id })
    expect((await call(pm, 'POST', `/work-items/${other.id}/cancel`)).statusCode).toBe(200)
    expect((await inbox(nurse2)).map((n) => n.kind)).toEqual(['request_update'])
    expect((await inbox(nurse2))[0]!.title).toContain('ยกเลิก')
    expect((await inbox(nurse2))[0]!.link).toBe('/requests')
  })

  it('live events address only the notified person and fire only for new notifications', async () => {
    const seen: LiveEvent[] = []
    app.deps.bus.subscribe((e) => {
      if (e.type === 'notification.created') seen.push(e)
    })
    const p = await project([[pm, ['PM']], [dev, ['PM', 'DEV']]])
    const wi = await createItem(p)
    const before = seen.length
    for (let i = 0; i < 2; i++) await call(pm, 'POST', `/tasks/${wi.tasks[0]!.id}/assign`, { personId: dev.id })
    const mine = seen.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toEqual({
      type: 'notification.created',
      projectId: null,
      workItemId: null,
      taskId: null,
      conversationId: null,
      personId: dev.id,
    })
    // Never written to the events table.
    const db = await testDb()
    expect(await db.select().from(events).where(eq(events.type, 'notification.created'))).toEqual([])
  })
})
