import type { FastifyInstance } from 'fastify'
import type { MyRequest, Task, TaskWithContext, Todo, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { attachments, tasks } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let ba: Who
let dev: Who
let qc: Who
let outsider: Who
let nurse: Who
let nurse2: Who

const NO_ID = '00000000-0000-4000-8000-000000000000'

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(members: [Who, string[]][]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string, body: Record<string, unknown> = {}): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
    title: 'เพิ่มรายงานแล็บ',
    templateKey: 'software-change',
    ...body,
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const detail = async (id: string): Promise<WorkItemDetail> => (await call(pm, 'GET', `/work-items/${id}`)).json()
const active = async (itemId: string, key: string): Promise<Task | undefined> =>
  (await detail(itemId)).tasks.filter((t) => t.templateTaskKey === key).at(-1)

/** Hands the task to `who` (as the PM) when needed, then submits it. */
async function drive(itemId: string, key: string, who: Who, result: Record<string, unknown> = { text: 'ok' }) {
  const t = (await active(itemId, key))!
  if (t.assigneeId !== who.id) {
    expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  }
  const res = await call(who, 'POST', `/tasks/${t.id}/submit`, result)
  expect(res.statusCode).toBe(200)
  // A finished step waits for the PM to confirm the advance (propose projects).
  await acceptStepAdvance(app, pm, itemId)
  return res.json() as TaskWithContext
}

const approve = { text: '', decision: 'approve' }
const requests = async (who: Who): Promise<MyRequest[]> => (await call(who, 'GET', '/me/requests')).json()
const answers = async (who: Who): Promise<TaskWithContext[]> => (await call(who, 'GET', '/me/answers')).json()

describe('requesters in the workflow', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    ba = await login(app, 'ba', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    qc = await login(app, 'qc', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1', { name: 'พยาบาลหนึ่ง' })
    nurse2 = await login(app, 'nurse2')
  })
  afterEach(async () => {
    await app.close()
  })

  it('the requester answers the BA questions; ids of other requests stay hidden', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const wi = await createItem(p, { requesterId: nurse.id })
    expect(wi).toMatchObject({ requesterId: nurse.id, requesterName: 'พยาบาลหนึ่ง' })
    expect((await requests(nurse)).map((r) => [r.workItemId, r.status])).toEqual([[wi.id, 'submitted']])
    expect(await answers(nurse)).toEqual([])

    await drive(wi.id, 'accept-intake', pm, approve)
    expect((await requests(nurse))[0]).toMatchObject({ status: 'in_progress', currentStepName: { en: 'Business analysis' } })
    await drive(wi.id, 'draft-requirements', ba, { text: 'คำถาม: ต้องการรายงานรายวันหรือรายเดือน?' })

    // Assigned straight to the requester (the project proposes by default; requester tasks are never proposed).
    const answer = (await active(wi.id, 'answer-questions'))!
    expect(answer).toMatchObject({ role: 'REQUESTER', state: 'open', assigneeId: nurse.id, proposedAssigneeId: null })
    expect(await active(wi.id, 'clarify-requirements')).toBeUndefined()

    const mine = await answers(nurse)
    expect(mine.map((t) => t.id)).toEqual([answer.id])
    expect(mine[0]!.inputs.map((i) => i.templateTaskKey)).toEqual(['draft-requirements'])
    expect(mine[0]!.inputs[0]!.result.text).toContain('รายวัน')
    expect((await requests(nurse))[0]!.status).toBe('waiting_for_you')
    expect(await requests(nurse2)).toEqual([])
    expect(await answers(nurse2)).toEqual([])

    // Read, start, submit as the requester.
    const got = await call(nurse, 'GET', `/tasks/${answer.id}`)
    expect(got.statusCode).toBe(200)
    expect((got.json() as TaskWithContext).inputs.map((i) => i.templateTaskKey)).toEqual(['draft-requirements'])
    expect((await call(nurse2, 'GET', `/tasks/${answer.id}`)).statusCode).toBe(404)
    expect((await call(nurse2, 'POST', `/tasks/${answer.id}/submit`, { text: 'x' })).statusCode).toBe(404)
    // Staff-only actions stay staff-only.
    expect((await call(nurse, 'POST', `/tasks/${answer.id}/assign`, { personId: nurse.id })).statusCode).toBe(403)
    expect((await call(nurse, 'POST', `/tasks/${answer.id}/confirm`)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', '/me/todo')).statusCode).toBe(403)

    expect((await call(nurse, 'POST', `/tasks/${answer.id}/start`)).statusCode).toBe(200)
    const submitted = await call(nurse, 'POST', `/tasks/${answer.id}/submit`, { text: 'รายวันครับ' })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json()).toMatchObject({ state: 'accepted', result: { text: 'รายวันครับ' } })
    const clarifyTask = (await active(wi.id, 'clarify-requirements'))!
    expect(clarifyTask).toMatchObject({ state: 'proposed', proposedAssigneeId: ba.id })
    // The BA sees both the draft and the requester's answers.
    const forBa = (await call(pm, 'GET', `/tasks/${clarifyTask.id}`)).json() as TaskWithContext
    expect(forBa.inputs.map((i) => i.templateTaskKey)).toEqual(['draft-requirements', 'answer-questions'])
    expect((await requests(nurse))[0]!.status).toBe('in_progress')
    expect(await answers(nurse)).toEqual([])

    // Other tasks of their own request, other work items' tasks and work item details → 404.
    const intake = (await active(wi.id, 'accept-intake'))!
    const clarify = (await active(wi.id, 'clarify-requirements'))!
    for (const id of [intake.id, clarify.id, NO_ID]) {
      expect((await call(nurse, 'GET', `/tasks/${id}`)).statusCode).toBe(404)
      expect((await call(nurse, 'POST', `/tasks/${id}/start`)).statusCode).toBe(404)
      expect((await call(nurse, 'POST', `/tasks/${id}/submit`, { text: 'x' })).statusCode).toBe(404)
    }
    const other = await createItem(p, { requesterId: nurse2.id })
    expect((await call(nurse, 'GET', `/tasks/${other.tasks[0]!.id}`)).statusCode).toBe(404)
    for (const id of [wi.id, other.id, NO_ID]) {
      expect((await call(nurse, 'GET', `/work-items/${id}`)).statusCode).toBe(404)
    }
    expect((await requests(nurse)).map((r) => r.workItemId)).toEqual([wi.id])
  })

  it('a requester view of a later task sees only its immediately preceding input', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']], [dev, ['DEV', 'SA']], [qc, ['QC']]])
    const wi = await createItem(p, { requesterId: nurse.id, templateKey: 'bug-fix' })
    await drive(wi.id, 'accept-bug', pm, approve)
    await drive(wi.id, 'implement', dev, { text: 'internal code notes' })
    await drive(wi.id, 'draft-tests', qc, { text: 'tests' })
    await drive(wi.id, 'review-code', dev, approve)
    await drive(wi.id, 'verify', qc, { text: 'ok' })
    await drive(wi.id, 'approve-release', qc, approve)

    const accept = (await active(wi.id, 'accept-delivery'))!
    expect(accept).toMatchObject({ role: 'REQUESTER', type: 'approval', state: 'open', assigneeId: nurse.id })
    const view = (await call(nurse, 'GET', `/tasks/${accept.id}`)).json() as TaskWithContext
    expect(view.inputs).toEqual([])
    expect(JSON.stringify(view)).not.toContain('internal code notes')
    expect((await call(nurse, 'POST', `/tasks/${accept.id}/submit`, { text: 'ใช้ได้', decision: 'approve' })).statusCode).toBe(200)
    expect(await active(wi.id, 'close-bug')).toMatchObject({ state: 'proposed', proposedAssigneeId: pm.id })
    await drive(wi.id, 'close-bug', pm, approve)
    expect((await requests(nurse))[0]).toMatchObject({ status: 'done', currentStepName: null })
  })

  it('without a requester, requester tasks go to the owner', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']], [qc, ['QC']]])
    const wi = await createItem(p, { templateKey: 'bug-fix', ownerId: dev.id })
    expect(wi).toMatchObject({ requesterId: null, requesterName: null })
    await drive(wi.id, 'accept-bug', pm, approve)
    await drive(wi.id, 'implement', dev, { text: 'x' })
    await drive(wi.id, 'draft-tests', qc, { text: 't' })
    await drive(wi.id, 'review-code', dev, approve)
    await drive(wi.id, 'verify', qc, { text: 'ok' })
    await drive(wi.id, 'approve-release', qc, approve)
    expect(await active(wi.id, 'accept-delivery')).toMatchObject({ state: 'open', assigneeId: dev.id, proposedAssigneeId: null })
    // The owner's own request list is about items they asked for, not items they own.
    expect(await requests(dev)).toEqual([])
  })

  it('a staff requester outside the project answers from /me/todo with the requester view', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const wi = await createItem(p, { requesterId: outsider.id })
    await drive(wi.id, 'accept-intake', pm, approve)
    await drive(wi.id, 'draft-requirements', ba, { text: 'คำถาม' })
    const answer = (await active(wi.id, 'answer-questions'))!
    expect(answer.assigneeId).toBe(outsider.id)

    const todo = (await call(outsider, 'GET', '/me/todo')).json() as Todo
    expect(todo.tasks.map((t) => t.id)).toEqual([answer.id])
    // Core tells the portal to show the requester view; project members and admins get the staff view.
    expect(todo.tasks[0]!.viewerIsRequester).toBe(true)
    expect(((await call(outsider, 'GET', `/tasks/${answer.id}`)).json() as TaskWithContext).viewerIsRequester).toBe(true)
    expect((await answers(outsider))[0]!.viewerIsRequester).toBe(true)
    for (const staff of [pm, ba, admin]) {
      expect(((await call(staff, 'GET', `/tasks/${answer.id}`)).json() as TaskWithContext).viewerIsRequester).toBe(false)
    }
    expect(((await call(pm, 'GET', '/me/todo')).json() as Todo).confirmations.every((t) => !t.viewerIsRequester)).toBe(true)
    expect((await answers(outsider)).map((t) => t.id)).toEqual([answer.id])
    expect((await call(outsider, 'GET', `/tasks/${answer.id}`)).statusCode).toBe(200)
    // Still no access to the rest of the project.
    expect((await call(outsider, 'GET', `/work-items/${wi.id}`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/tasks/${(await active(wi.id, 'accept-intake'))!.id}`)).statusCode).toBe(404)
    expect((await call(outsider, 'POST', `/tasks/${answer.id}/confirm`)).statusCode).toBe(404)
    expect((await call(outsider, 'POST', `/tasks/${answer.id}/submit`, { text: 'ตอบแล้ว' })).statusCode).toBe(200)
    expect((await requests(outsider))[0]).toMatchObject({ workItemId: wi.id, status: 'in_progress' })
  })

  it('the requester view hides staff files and staff names on attachments', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const wi = await createItem(p, { requesterId: nurse.id })
    await drive(wi.id, 'accept-intake', pm, approve)
    const db = await testDb()
    const file = async (uploadedBy: string, fileName: string, over: Record<string, unknown> = {}) =>
      (
        await db
          .insert(attachments)
          .values({ projectId: p, storageKey: `k-${Math.random()}`, fileName, contentType: 'text/plain', sizeBytes: 1, uploadedBy, ...over })
          .returning()
      )[0]!
    const internal = await file(ba.id, 'internal-notes.txt')
    await drive(wi.id, 'draft-requirements', ba, { text: 'คำถาม', attachmentIds: [internal.id] })
    const draft = (await active(wi.id, 'draft-requirements'))!
    // A sample the requester gave earlier, sitting on the draft task.
    await file(nurse.id, 'sample-from-nurse.pdf', { taskId: draft.id, workItemId: wi.id })
    const answer = (await active(wi.id, 'answer-questions'))!
    await file(nurse.id, 'my-answer.pdf', { taskId: answer.id, workItemId: wi.id })
    // A file staff put on the requester's own task: visible, but not who uploaded it.
    await file(ba.id, 'staff-on-answer.pdf', { taskId: answer.id, workItemId: wi.id })

    const view = (await call(nurse, 'GET', `/tasks/${answer.id}`)).json() as TaskWithContext
    expect(view.inputs[0]!.attachments.map((a) => [a.fileName, a.uploadedByName, a.uploadedById])).toEqual([
      ['sample-from-nurse.pdf', '', nurse.id],
    ])
    // The staff file's id is dropped from the input's result too.
    expect(view.inputs[0]!.result.attachmentIds).toEqual([])
    expect(view.attachments.map((a) => [a.fileName, a.uploadedByName, a.uploadedById]).sort()).toEqual([
      ['my-answer.pdf', '', nurse.id],
      ['staff-on-answer.pdf', '', null],
    ])
    for (const body of [JSON.stringify(view), JSON.stringify(await answers(nurse))]) {
      expect(body).not.toContain('internal-notes')
      expect(body).not.toContain(internal.id)
      expect(body).not.toContain(ba.id)
    }
    // Staff still see everything.
    const staff = (await call(pm, 'GET', `/tasks/${answer.id}`)).json() as TaskWithContext
    expect(staff.inputs[0]!.attachments.map((a) => a.fileName).sort()).toEqual(['internal-notes.txt', 'sample-from-nurse.pdf'])
    expect(staff.inputs[0]!.attachments.every((a) => a.uploadedByName !== '')).toBe(true)
    expect(staff.inputs[0]!.result.attachmentIds).toEqual([internal.id])
  })

  it('a requester cannot pull project files into their task', async () => {
    const p = await project([[pm, ['PM']], [ba, ['BA']]])
    const wi = await createItem(p, { requesterId: nurse.id })
    await drive(wi.id, 'accept-intake', pm, approve)
    await drive(wi.id, 'draft-requirements', ba, { text: 'คำถาม' })
    const answer = (await active(wi.id, 'answer-questions'))!
    const db = await testDb()
    const [file] = await db
      .insert(attachments)
      .values({ projectId: p, storageKey: `k-${Math.random()}`, fileName: 'internal.txt', contentType: 'text/plain', sizeBytes: 1, uploadedBy: pm.id })
      .returning()
    const res = await call(nurse, 'POST', `/tasks/${answer.id}/submit`, { text: 'x', attachmentIds: [file!.id] })
    expect(res.statusCode).toBe(404)
    const [after] = await db.select().from(attachments).where(eq(attachments.id, file!.id))
    expect(after).toMatchObject({ taskId: null, workItemId: null })
    const [t] = await db.select().from(tasks).where(eq(tasks.id, answer.id))
    expect(t!.state).toBe('open')
  })

  it('/me/requests reports cancelled items and is newest first', async () => {
    const p = await project([[pm, ['PM']]])
    const first = await createItem(p, { requesterId: nurse.id, templateKey: 'bug-fix', title: 'หนึ่ง' })
    const second = await createItem(p, { requesterId: nurse.id, templateKey: 'bug-fix', title: 'สอง' })
    expect((await call(pm, 'POST', `/work-items/${first.id}/cancel`)).statusCode).toBe(200)
    const list = await requests(nurse)
    expect(list.map((r) => [r.title, r.status, r.projectName])).toEqual([
      ['สอง', 'submitted', 'ระบบรายงานแล็บ'],
      ['หนึ่ง', 'cancelled', 'ระบบรายงานแล็บ'],
    ])
    expect(list[0]).toMatchObject({ workItemId: second.id, currentStepName: { en: 'Intake' } })
  })

  it('rejects an unknown requester id', async () => {
    const p = await project([[pm, ['PM']]])
    const res = await call(pm, 'POST', `/projects/${p}/work-items`, { title: 'x', templateKey: 'bug-fix', requesterId: NO_ID })
    expect(res.statusCode).toBe(404)
  })
})
