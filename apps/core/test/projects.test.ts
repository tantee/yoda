import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Todo, WorkItemDetail } from '@yoda/shared'
import { and, asc, eq } from 'drizzle-orm'
import { events, projectMembers } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let somchai: Who
let other: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function createProject(name = 'ระบบรายงานแล็บ') {
  const res = await call(admin, 'POST', '/projects', { name })
  return res.json() as { id: string }
}

describe('projects API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    somchai = await login(app, 'somchai', { staff: true, name: 'สมชาย' })
    other = await login(app, 'other', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('requester gets 403 on projects routes', async () => {
    expect((await call(nurse, 'GET', '/projects')).statusCode).toBe(403)
    expect((await call(nurse, 'POST', '/projects', { name: 'x' })).statusCode).toBe(403)
  })

  it('non-admin staff gets 403 on POST /projects', async () => {
    const res = await call(somchai, 'POST', '/projects', { name: 'x' })
    expect(res.statusCode).toBe(403)
  })

  it('admin creates a project (Thai name trimmed, defaults)', async () => {
    const res = await call(admin, 'POST', '/projects', { name: ' ระบบรายงานแล็บ ' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ name: 'ระบบรายงานแล็บ', autonomy: 'propose', noAi: false })
    const list = await call(admin, 'GET', '/projects')
    expect(list.json()[0].name).toBe('ระบบรายงานแล็บ')
  })

  it('membership controls visibility', async () => {
    const p = await createProject()
    const put = await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, {
      roles: ['PM', 'DEV'],
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().members).toEqual([
      { personId: somchai.id, displayName: 'สมชาย', roles: ['PM', 'DEV'] },
    ])
    expect((await call(somchai, 'GET', '/projects')).json().map((x: { id: string }) => x.id)).toEqual([p.id])
    expect((await call(somchai, 'GET', `/projects/${p.id}`)).statusCode).toBe(200)
    expect((await call(other, 'GET', '/projects')).json()).toEqual([])
    const hidden = await call(other, 'GET', `/projects/${p.id}`)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toEqual({ error: 'not_found' })
    expect((await call(admin, 'GET', `/projects/${p.id}`)).statusCode).toBe(200)
  })

  it('rejects adding a non-staff person (422) but accepts staff', async () => {
    const p = await createProject()
    const bad = await call(admin, 'PUT', `/projects/${p.id}/members/${nurse.id}`, { roles: ['DEV'] })
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toEqual({ error: 'not_staff' })
    const ok = await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['DEV'] })
    expect(ok.statusCode).toBe(200)
  })

  it('database rejects invalid or empty roles', async () => {
    const p = await createProject()
    const db = await testDb()
    await expect(
      db.insert(projectMembers).values({ projectId: p.id, personId: somchai.id, roles: ['BOSS'] }),
    ).rejects.toThrow()
    await expect(
      db.insert(projectMembers).values({ projectId: p.id, personId: somchai.id, roles: [] }),
    ).rejects.toThrow()
  })

  it('PM can add members; DEV-only member cannot', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM', 'DEV'] })
    const add = await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['BA'] })
    expect(add.statusCode).toBe(200)
    await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV'] })
    const denied = await call(other, 'PUT', `/projects/${p.id}/members/${nurse.id}`, { roles: ['QC'] })
    expect(denied.statusCode).toBe(403)
    expect((await call(other, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)).statusCode).toBe(403)
  })

  it('PUT validates roles and ids', async () => {
    const p = await createProject()
    const url = `/projects/${p.id}/members/${somchai.id}`
    expect((await call(admin, 'PUT', url, { roles: [] })).statusCode).toBe(400)
    expect((await call(admin, 'PUT', url, { roles: ['CEO'] })).statusCode).toBe(400)
    const noPerson = await call(admin, 'PUT', `/projects/${p.id}/members/00000000-0000-4000-8000-000000000000`, { roles: ['DEV'] })
    expect(noPerson.statusCode).toBe(404)
    const noProject = await call(admin, 'PUT', `/projects/00000000-0000-4000-8000-000000000000/members/${somchai.id}`, { roles: ['DEV'] })
    expect(noProject.statusCode).toBe(404)
  })

  it('cannot remove the last PM while others remain', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    await call(admin, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['BA'] })
    const res = await call(admin, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'last_pm' })
    // Demoting the last PM is blocked too.
    const demote = await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['DEV'] })
    expect(demote.statusCode).toBe(409)
    // Removing a non-PM works; then the sole remaining PM can be removed.
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${other.id}`)).statusCode).toBe(204)
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${somchai.id}`)).statusCode).toBe(204)
  })

  it('DELETE of a non-member is 404', async () => {
    const p = await createProject()
    expect((await call(admin, 'DELETE', `/projects/${p.id}/members/${other.id}`)).statusCode).toBe(404)
  })
  it('PATCH sets autonomy for the PM or an admin only', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    await call(admin, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV'] })
    const res = await call(somchai, 'PATCH', `/projects/${p.id}`, { autonomy: 'auto-assign' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: p.id, autonomy: 'auto-assign', members: [{}, {}] })
    expect((await call(other, 'PATCH', `/projects/${p.id}`, { autonomy: 'propose' })).statusCode).toBe(403)
    expect((await call(nurse, 'PATCH', `/projects/${p.id}`, { autonomy: 'propose' })).statusCode).toBe(403)
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { autonomy: 'sometimes' })).statusCode).toBe(400)
    expect((await call(admin, 'PATCH', `/projects/${p.id}`, { autonomy: 'propose' })).json().autonomy).toBe('propose')
    expect((await call(admin, 'PATCH', '/projects/00000000-0000-4000-8000-000000000000', { autonomy: 'propose' })).statusCode).toBe(404)
  })

  it('PATCH persists aiBudgetUsd and noAi, and null clears the budget', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    const res = await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 25 })
    expect(res.statusCode).toBe(200)
    expect(res.json().aiBudgetUsd).toBe(25)
    expect((await call(somchai, 'GET', `/projects/${p.id}`)).json().aiBudgetUsd).toBe(25)
    const noAi = await call(somchai, 'PATCH', `/projects/${p.id}`, { noAi: true })
    expect(noAi.json()).toMatchObject({ noAi: true, aiBudgetUsd: 25 })
    expect((await call(somchai, 'GET', `/projects/${p.id}`)).json().noAi).toBe(true)
    const cleared = await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: null })
    expect(cleared.json().aiBudgetUsd).toBeNull()
    // numeric(12,2) holds up to 9 999 999 999.99: larger values are a 400, not a database 500.
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 9_999_999_999 })).statusCode).toBe(200)
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 1e12 })).statusCode).toBe(400)
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 9_999_999_999.99 })).statusCode).toBe(200)
    // Would round past numeric(12,2) (or silently lose a cent): rejected.
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 9_999_999_999.999 })).statusCode).toBe(400)
    expect((await call(somchai, 'PATCH', `/projects/${p.id}`, { aiBudgetUsd: 1.005 })).statusCode).toBe(400)
  })

  it('removing a member unassigns their open and proposed tasks into the PM confirmations', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    await call(admin, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV'] })
    const wi = (await call(somchai, 'POST', `/projects/${p.id}/work-items`, { title: 'แก้รายงานแล็บ', templateKey: 'bug-fix' })).json() as WorkItemDetail
    const accept = wi.tasks[0]!.id
    await call(somchai, 'POST', `/tasks/${accept}/confirm`)
    await call(somchai, 'POST', `/tasks/${accept}/submit`, { decision: 'approve' })
    expect(await acceptStepAdvance(app, somchai, wi.id)).toBe(true)
    const key = async (k: string) =>
      ((await call(somchai, 'GET', `/work-items/${wi.id}`)).json() as WorkItemDetail).tasks.find((t) => t.templateTaskKey === k)!
    const impl = await key('implement')
    const draft = await key('draft-tests')
    await call(somchai, 'POST', `/tasks/${impl.id}/assign`, { personId: other.id })
    await call(somchai, 'POST', `/tasks/${draft.id}/assign`, { personId: other.id })
    await call(other, 'POST', `/tasks/${impl.id}/submit`, { text: 'code' })
    const review = await key('review-code')
    expect(review).toMatchObject({ state: 'proposed', proposedAssigneeId: other.id })
    expect(await key('draft-tests')).toMatchObject({ state: 'open', assigneeId: other.id })

    expect((await call(somchai, 'DELETE', `/projects/${p.id}/members/${other.id}`)).statusCode).toBe(204)

    for (const id of [draft.id, review.id]) {
      const t = (await call(somchai, 'GET', `/tasks/${id}`)).json()
      expect(t).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
    }
    const todo = (await call(somchai, 'GET', '/me/todo')).json() as Todo
    expect(todo.confirmations.map((c) => c.id).sort()).toEqual([draft.id, review.id].sort())
    const db = await testDb()
    const unassigned = await db
      .select()
      .from(events)
      .where(and(eq(events.workItemId, wi.id), eq(events.type, 'task.unassigned')))
      .orderBy(asc(events.seq))
    expect(unassigned.map((e) => e.taskId).sort()).toEqual([draft.id, review.id].sort())
    expect(unassigned.every((e) => e.reason === 'member_removed' && e.actorId === somchai.id)).toBe(true)
    // The removed member can no longer see the project's tasks.
    expect((await call(other, 'GET', `/tasks/${draft.id}`)).statusCode).toBe(404)
  })

  it('removing a role unassigns that person\'s active tasks with that role (reason role_removed)', async () => {
    const p = await createProject()
    await call(admin, 'PUT', `/projects/${p.id}/members/${somchai.id}`, { roles: ['PM'] })
    await call(admin, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV', 'QC'] })
    await call(somchai, 'PATCH', `/projects/${p.id}`, { autonomy: 'auto-assign' })
    const wi = (await call(somchai, 'POST', `/projects/${p.id}/work-items`, { title: 'แก้รายงานแล็บ', templateKey: 'bug-fix' })).json() as WorkItemDetail
    await call(somchai, 'POST', `/tasks/${wi.tasks[0]!.id}/submit`, { decision: 'approve' })
    const key = async (k: string) =>
      ((await call(somchai, 'GET', `/work-items/${wi.id}`)).json() as WorkItemDetail).tasks.find((t) => t.templateTaskKey === k)!
    const impl = await key('implement')
    const tests = await key('draft-tests')
    await call(somchai, 'POST', `/tasks/${impl.id}/assign`, { personId: other.id })
    await call(somchai, 'POST', `/tasks/${tests.id}/assign`, { personId: other.id })
    expect(await key('implement')).toMatchObject({ state: 'open', assigneeId: other.id })

    // Unchanged roles: nothing happens.
    expect((await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['DEV', 'QC'] })).statusCode).toBe(200)
    expect(await key('implement')).toMatchObject({ assigneeId: other.id })

    const put = await call(somchai, 'PUT', `/projects/${p.id}/members/${other.id}`, { roles: ['QC'] })
    expect(put.statusCode).toBe(200)
    expect(await key('implement')).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
    // The QC task they still hold stays theirs.
    expect(await key('draft-tests')).toMatchObject({ state: 'open', assigneeId: other.id })
    expect(((await call(somchai, 'GET', '/me/todo')).json() as Todo).confirmations.map((c) => c.id)).toContain(impl.id)
    const db = await testDb()
    const unassigned = await db
      .select()
      .from(events)
      .where(and(eq(events.workItemId, wi.id), eq(events.type, 'task.unassigned')))
    expect(unassigned.map((e) => [e.taskId, e.reason, e.actorId])).toEqual([[impl.id, 'role_removed', somchai.id]])
    expect(unassigned[0]!.payload).toEqual({ personId: other.id, roles: ['DEV'] })
  })
})
