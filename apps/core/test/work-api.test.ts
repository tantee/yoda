import type { FastifyInstance } from 'fastify'
import type { Task, TaskWithContext, Todo, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { attachments } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let dev: Who
let qc: Who
let outsider: Who
let nurse: Who

const NO_ID = '00000000-0000-4000-8000-000000000000'

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(members: [Who, string[]][], name = 'ระบบรายงานแล็บ'): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of members) {
    const res = await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })
    expect(res.statusCode).toBe(200)
  }
  return id
}

async function createItem(who: Who, projectId: string, body: Record<string, unknown> = {}): Promise<WorkItemDetail> {
  const res = await call(who, 'POST', `/projects/${projectId}/work-items`, {
    title: 'แก้รายงานแล็บ',
    templateKey: 'bug-fix',
    ...body,
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const detail = async (who: Who, id: string): Promise<WorkItemDetail> =>
  (await call(who, 'GET', `/work-items/${id}`)).json()
const todo = async (who: Who): Promise<Todo> => (await call(who, 'GET', '/me/todo')).json()

/** The active (latest) attempt of a template task in the work item. */
async function active(who: Who, itemId: string, key: string): Promise<Task> {
  const ts = (await detail(who, itemId)).tasks.filter((t) => t.templateTaskKey === key)
  return ts.at(-1)!
}

/** Hands the task to `who` (confirming or assigning as the PM when needed), then submits it. */
async function drive(itemId: string, key: string, who: Who, result: Record<string, unknown> = { text: 'ok' }) {
  const t = await active(pm, itemId, key)
  if (t.assigneeId !== who.id) {
    const res = await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })
    expect(res.statusCode).toBe(200)
  }
  const res = await call(who, 'POST', `/tasks/${t.id}/submit`, result)
  expect(res.statusCode).toBe(200)
  // A finished step waits for the PM to confirm the advance (propose projects).
  await acceptStepAdvance(app, pm, itemId)
  return res.json() as TaskWithContext
}

const approve = { text: '', decision: 'approve' }

describe('work API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true, name: 'สมศรี' })
    dev = await login(app, 'dev', { staff: true, name: 'สมชาย' })
    qc = await login(app, 'qc', { staff: true, name: 'สมหญิง' })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('requesters get 403 (or 404 where they may hold a task) and non-member staff get 404', async () => {
    expect((await call(nurse, 'GET', '/workflow-templates')).statusCode).toBe(403)
    expect((await call(nurse, 'GET', '/me/todo')).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/tasks/${NO_ID}`)).statusCode).toBe(404)
    expect((await call(nurse, 'GET', `/work-items/${NO_ID}`)).statusCode).toBe(404)

    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    const taskId = wi.tasks[0]!.id

    expect((await call(nurse, 'GET', `/work-items/${wi.id}`)).statusCode).toBe(404)
    expect((await call(nurse, 'GET', `/tasks/${taskId}`)).statusCode).toBe(404)
    expect((await call(nurse, 'POST', `/tasks/${taskId}/submit`, { text: 'x' })).statusCode).toBe(404)
    expect((await call(nurse, 'POST', `/tasks/${taskId}/confirm`)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/projects/${p}/work-items`)).statusCode).toBe(403)

    const hidden = await call(outsider, 'GET', `/work-items/${wi.id}`)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toEqual({ error: 'not_found' })
    expect((await call(outsider, 'GET', `/tasks/${taskId}`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/projects/${p}/work-items`)).statusCode).toBe(404)
    expect((await call(outsider, 'POST', `/projects/${p}/work-items`, { title: 'x', templateKey: 'bug-fix' })).statusCode).toBe(404)
    // Mutations by non-members do not reveal the task either.
    expect((await call(outsider, 'POST', `/tasks/${taskId}/start`)).statusCode).toBe(404)
    expect((await call(outsider, 'POST', `/tasks/${taskId}/confirm`)).statusCode).toBe(404)
    expect((await call(outsider, 'POST', `/work-items/${wi.id}/cancel`)).statusCode).toBe(404)
    expect((await call(dev, 'GET', `/tasks/${NO_ID}`)).statusCode).toBe(404)
    expect((await call(admin, 'GET', `/tasks/${taskId}`)).statusCode).toBe(200)
  })

  it('lists the latest workflow templates sorted by key', async () => {
    const res = await call(dev, 'GET', '/workflow-templates')
    expect(res.statusCode).toBe(200)
    const list = res.json() as { key: string; version: number; steps: { key: string }[] }[]
    expect(list.map((t) => t.key)).toEqual(['bug-fix', 'software-change'])
    expect(list[0]!.steps.map((s) => s.key)).toEqual(['intake', 'dev', 'qc', 'close'])
    expect(list[0]!.version).toBe(1)
  })

  it('a member creates a work item and reads it back', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const res = await call(dev, 'POST', `/projects/${p}/work-items`, { title: 'แก้รายงานแล็บ', templateKey: 'bug-fix' })
    expect(res.statusCode).toBe(201)
    const wi = res.json() as WorkItemDetail
    expect(wi).toMatchObject({
      title: 'แก้รายงานแล็บ',
      templateKey: 'bug-fix',
      templateVersion: 1,
      currentStepKey: 'intake',
      priority: 'normal',
      ownerId: dev.id,
      ownerName: 'สมชาย',
      state: 'active',
    })
    expect(wi.tasks).toHaveLength(1)
    expect(wi.tasks[0]).toMatchObject({
      templateTaskKey: 'accept-bug',
      title: { en: 'Accept the request' },
      state: 'proposed',
      proposedAssigneeId: pm.id,
      proposedAssigneeName: 'สมศรี',
    })
    expect(wi.events.length).toBeGreaterThan(0)
    expect(wi.events[0]).toMatchObject({ type: 'work_item.created', actorId: dev.id, actorName: 'สมชาย' })
    expect(wi.steps.map((s) => s.status)).toEqual(['current', 'pending', 'pending', 'pending'])

    expect((await call(pm, 'GET', `/work-items/${wi.id}`)).json()).toEqual(wi)
    const list = await call(pm, 'GET', `/projects/${p}/work-items`)
    expect(list.statusCode).toBe(200)
    expect(list.json().map((w: { id: string }) => w.id)).toEqual([wi.id])

    expect((await call(dev, 'POST', `/projects/${p}/work-items`, { title: ' ', templateKey: 'bug-fix' })).statusCode).toBe(400)
  })

  it('propose flow: the PM confirms a proposed task into the assignee to-do', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    const t = wi.tasks[0]!
    const before = await todo(pm)
    expect(before.confirmations.map((c) => c.id)).toEqual([t.id])
    expect(before.confirmations[0]).toMatchObject({ workItemTitle: 'แก้รายงานแล็บ', projectName: 'ระบบรายงานแล็บ' })
    expect(before.tasks).toEqual([])
    // Context for the page: the item's step track and project name.
    expect(before.workItems[wi.id]).toMatchObject({ title: 'แก้รายงานแล็บ', projectId: p, projectName: 'ระบบรายงานแล็บ', priority: 'normal', targetDate: null })
    expect(before.workItems[wi.id]!.steps.map((s) => s.status)).toEqual(['current', 'pending', 'pending', 'pending'])
    expect(before.projectNames).toEqual({ [p]: 'ระบบรายงานแล็บ' })
    expect((await todo(dev)).confirmations).toEqual([])
    expect((await todo(dev)).workItems).toEqual({})

    expect((await call(dev, 'POST', `/tasks/${t.id}/confirm`)).statusCode).toBe(403)
    const res = await call(pm, 'POST', `/tasks/${t.id}/confirm`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: t.id, state: 'open', assigneeId: pm.id, proposedAssigneeId: null })
    const after = await todo(pm)
    expect(after.tasks.map((x) => x.id)).toEqual([t.id])
    expect(after.confirmations).toEqual([])
    expect((await call(pm, 'POST', `/tasks/${t.id}/confirm`)).statusCode).toBe(409)

    const started = await call(pm, 'POST', `/tasks/${t.id}/start`)
    expect(started.json()).toMatchObject({ state: 'in_progress' })
    const submitted = await call(pm, 'POST', `/tasks/${t.id}/submit`, approve)
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json()).toMatchObject({ state: 'accepted', result: { decision: 'approve' } })
    // The finished step waits for the PM to confirm the advance.
    expect((await detail(pm, wi.id)).currentStepKey).toBe('intake')
    const decide = await todo(pm)
    expect(decide.proposals.map((x) => x.kind)).toEqual(['step_advance'])
    expect(decide.workItems[wi.id]!.steps.map((s) => s.status)).toEqual(['current', 'pending', 'pending', 'pending'])
    expect(await acceptStepAdvance(app, pm, wi.id)).toBe(true)
    expect((await detail(pm, wi.id)).currentStepKey).toBe('dev')
  })

  it('no-candidate flow: an unassigned verify task waits for the PM to assign', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    await drive(wi.id, 'accept-bug', pm, approve)
    await drive(wi.id, 'implement', dev)
    await drive(wi.id, 'draft-tests', dev)
    await drive(wi.id, 'review-code', dev, approve)

    const verify = await active(pm, wi.id, 'verify')
    expect(verify).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null, executor: 'human' })
    expect((await todo(pm)).confirmations.map((c) => c.id)).toContain(verify.id)

    const bad = await call(pm, 'POST', `/tasks/${verify.id}/assign`, { personId: outsider.id })
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toEqual({ error: 'not_member' })
    expect((await call(pm, 'POST', `/tasks/${verify.id}/assign`, { personId: 'nope' })).statusCode).toBe(400)
    const ok = await call(pm, 'POST', `/tasks/${verify.id}/assign`, { personId: dev.id })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ assigneeId: dev.id, assigneeName: 'สมชาย', state: 'open' })
    expect((await todo(pm)).confirmations.map((c) => c.id)).not.toContain(verify.id)
    expect((await todo(dev)).tasks.map((x) => x.id)).toContain(verify.id)

    const d = await detail(pm, wi.id)
    expect(d.steps.map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending'])
    // Tasks follow step order, then template order, then attempt.
    expect(d.tasks.map((t) => t.templateTaskKey)).toEqual([
      'accept-bug', 'implement', 'draft-tests', 'review-code', 'verify',
    ])
    const seqTypes = d.events.map((e) => e.type)
    expect(seqTypes[0]).toBe('work_item.created')
    expect(seqTypes.at(-1)).toBe('task.assigned')
  })

  it('projects without a PM surface unassigned tasks to admins only', async () => {
    const p = await project([[dev, ['DEV']]])
    const wi = await createItem(dev, p)
    const t = wi.tasks[0]!
    expect(t).toMatchObject({ state: 'open', assigneeId: null, executor: 'human' })
    expect((await todo(admin)).confirmations.map((c) => c.id)).toEqual([t.id])
    expect((await todo(dev)).confirmations).toEqual([])
    expect((await todo(pm)).confirmations).toEqual([])

    // Once the project has a PM, admins no longer see it; the PM does.
    await call(admin, 'PUT', `/projects/${p}/members/${pm.id}`, { roles: ['PM'] })
    expect((await todo(admin)).confirmations).toEqual([])
    expect((await todo(pm)).confirmations.map((c) => c.id)).toEqual([t.id])
  })

  it('assigning an ai task is a takeover by a human', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    await drive(wi.id, 'accept-bug', pm, approve)
    const impl = await active(pm, wi.id, 'implement')
    expect(impl).toMatchObject({ executor: 'ai', assigneeId: null })
    expect((await todo(pm)).confirmations.map((c) => c.id)).toContain(impl.id)

    const res = await call(pm, 'POST', `/tasks/${impl.id}/assign`, { personId: dev.id })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ executor: 'human', assigneeId: dev.id })
    const submitted = await call(dev, 'POST', `/tasks/${impl.id}/submit`, { text: 'done' })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json()).toMatchObject({ state: 'accepted', result: { text: 'done' } })
  })

  it('unassigned ai tasks wait in the PM confirmations', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    await drive(wi.id, 'accept-bug', pm, approve)
    const impl = await active(pm, wi.id, 'implement')
    const tests = await active(pm, wi.id, 'draft-tests')
    expect(impl).toMatchObject({ executor: 'ai', assigneeId: null, state: 'open' })
    const ids = (await todo(pm)).confirmations.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([impl.id, tests.id]))
    expect((await todo(dev)).confirmations).toEqual([])
  })

  it('to-do tasks are ordered by priority, then age', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const normal = await createItem(pm, p, { title: 'ปกติ' })
    const urgent = await createItem(pm, p, { title: 'ด่วน', priority: 'urgent' })
    const low = await createItem(pm, p, { title: 'ไม่รีบ', priority: 'low' })
    for (const wi of [normal, urgent, low]) {
      expect((await call(pm, 'POST', `/tasks/${wi.tasks[0]!.id}/confirm`)).statusCode).toBe(200)
    }
    const ordered = (await todo(pm)).tasks
    expect(ordered.map((t) => t.workItemTitle)).toEqual(['ด่วน', 'ปกติ', 'ไม่รีบ'])
    expect(ordered.map((t) => t.workItemPriority)).toEqual(['urgent', 'normal', 'low'])
    const list = (await call(pm, 'GET', `/projects/${p}/work-items`)).json() as { title: string }[]
    expect(list.map((w) => w.title)).toEqual(['ไม่รีบ', 'ด่วน', 'ปกติ'])
  })

  it('cancel: owner or PM; returns the cancelled detail', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']], [qc, ['QC']]])
    const wi = await createItem(dev, p)
    expect((await call(qc, 'POST', `/work-items/${wi.id}/cancel`)).statusCode).toBe(403)
    const res = await call(dev, 'POST', `/work-items/${wi.id}/cancel`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ state: 'cancelled', tasks: [{ state: 'rejected' }] })
    expect((await todo(pm)).confirmations).toEqual([])
  })

  async function attach(projectId: string, by: Who, over: Partial<typeof attachments.$inferInsert> = {}): Promise<string> {
    const [row] = await app.deps.db
      .insert(attachments)
      .values({
        projectId,
        storageKey: `projects/${projectId}/${Math.random()}/ผลแล็บ.txt`,
        fileName: 'ผลแล็บ.txt',
        contentType: 'text/plain',
        sizeBytes: 3,
        extractedText: 'abc',
        uploadedBy: by.id,
        ...over,
      })
      .returning()
    return row!.id
  }

  it('a review task gets the implement result and its attachments as an input', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const wi = await createItem(pm, p)
    await drive(wi.id, 'accept-bug', pm, approve)
    const fileId = await attach(p, dev, { noAi: true })
    const impl = await drive(wi.id, 'implement', dev, { text: 'แก้แล้ว', attachmentIds: [fileId] })
    expect(impl.result).toEqual({ text: 'แก้แล้ว', attachmentIds: [fileId] })
    expect(impl.attachments.map((a) => a.id)).toEqual([fileId])

    const review = await active(pm, wi.id, 'review-code')
    const res = await call(dev, 'GET', `/tasks/${review.id}`)
    expect(res.statusCode).toBe(200)
    const body = res.json() as TaskWithContext
    expect(body.inputs).toHaveLength(1)
    expect(body.inputs[0]).toMatchObject({
      templateTaskKey: 'implement',
      title: { th: 'พัฒนาโค้ด' },
      executor: 'human',
      result: { text: 'แก้แล้ว' },
    })
    expect(body.inputs[0]!.attachments).toMatchObject([{ id: fileId, noAi: true, taskId: impl.id }])
    expect(body.attachments).toEqual([])
    // To-do lists carry the same inputs.
    const lists = await todo(pm)
    const listed = [...lists.tasks, ...lists.confirmations].find((t) => t.id === review.id)!
    expect(listed.inputs.map((i) => i.result.text)).toEqual(['แก้แล้ว'])
  })

  it('submitting with an attachment of another project is 404 and changes nothing', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']]])
    const other = await project([[pm, ['PM']]], 'อีกโครงการ')
    const wi = await createItem(pm, p)
    await drive(wi.id, 'accept-bug', pm, approve)
    const foreign = await attach(other, pm)
    const impl = await active(pm, wi.id, 'implement')
    expect((await call(pm, 'POST', `/tasks/${impl.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
    const res = await call(dev, 'POST', `/tasks/${impl.id}/submit`, { text: 'x', attachmentIds: [foreign] })
    expect(res.statusCode).toBe(404)
    expect((await active(pm, wi.id, 'implement')).state).toBe('open')
    const unknown = await call(dev, 'POST', `/tasks/${impl.id}/submit`, { text: 'x', attachmentIds: [NO_ID] })
    expect(unknown.statusCode).toBe(404)
  })

  it('events in the detail carry the actor kind', async () => {
    const p = await project([[pm, ['PM']]])
    const wi = await createItem(pm, p)
    expect(wi.events.length).toBeGreaterThan(0)
    expect(wi.events.every((e) => e.actorKind === 'person')).toBe(true)
  })

  it('a submit never moves files off other tasks; project-level files join the work item', async () => {
    const p = await project([[pm, ['PM']], [dev, ['DEV']], [qc, ['QC']]])
    const wi = await createItem(pm, p)
    const wi2 = await createItem(pm, p, { title: 'งานอื่น' })
    await drive(wi.id, 'accept-bug', pm, approve)
    const projectFile = await attach(p, dev)
    const impl = await drive(wi.id, 'implement', dev, { text: 'แก้แล้ว', attachmentIds: [projectFile] })
    const listed = (await call(dev, 'GET', `/projects/${p}/attachments?workItemId=${wi.id}`)).json() as { id: string; taskId: string }[]
    expect(listed).toMatchObject([{ id: projectFile, taskId: impl.id }])

    // Already linked to the accepted implement task → refused, link intact.
    const tests = await active(pm, wi.id, 'draft-tests')
    expect((await call(pm, 'POST', `/tasks/${tests.id}/assign`, { personId: qc.id })).statusCode).toBe(200)
    const stolen = await call(qc, 'POST', `/tasks/${tests.id}/submit`, { text: 't', attachmentIds: [projectFile] })
    expect(stolen.statusCode).toBe(409)
    expect(stolen.json()).toEqual({ error: 'invalid_state' })
    expect((await active(pm, wi.id, 'draft-tests')).state).toBe('open')
    expect((await call(dev, 'GET', `/tasks/${impl.id}`)).json()).toMatchObject({ attachments: [{ id: projectFile }] })

    // A file on another work item → refused too.
    const otherItemFile = await attach(p, dev, { workItemId: wi2.id })
    const res = await call(qc, 'POST', `/tasks/${tests.id}/submit`, { text: 't', attachmentIds: [otherItemFile] })
    expect(res.statusCode).toBe(409)
    const [row] = await app.deps.db.select().from(attachments).where(eq(attachments.id, otherItemFile))
    expect(row).toMatchObject({ workItemId: wi2.id, taskId: null })
  })

  describe('reopen', () => {
    const reopen = (who: Who, id: string, stepKey: unknown) => call(who, 'POST', `/work-items/${id}/reopen`, { stepKey })

    /** A bug fix for `nurse` up to the delivery check, where the requester asks for changes. */
    async function changesRequested(): Promise<{ p: string; wi: WorkItemDetail }> {
      const p = await project([[pm, ['PM']], [dev, ['DEV']], [qc, ['QC']]])
      const wi = await createItem(pm, p, { requesterId: nurse.id })
      await drive(wi.id, 'accept-bug', pm, approve)
      await drive(wi.id, 'implement', dev, { text: 'x' })
      await drive(wi.id, 'draft-tests', qc, { text: 't' })
      await drive(wi.id, 'review-code', dev, approve)
      await drive(wi.id, 'verify', qc, { text: 'ok' })
      await drive(wi.id, 'approve-release', qc, approve)
      const accept = await active(pm, wi.id, 'accept-delivery')
      expect(accept.assigneeId).toBe(nurse.id)
      const res = await call(nurse, 'POST', `/tasks/${accept.id}/submit`, { text: 'สีรายงานยังผิด', decision: 'changes' })
      expect(res.statusCode).toBe(200)
      // The requester's recreated attempt is kept: they may still accept as is.
      expect(await active(pm, wi.id, 'accept-delivery')).toMatchObject({ attempt: 2, state: 'open', assigneeId: nurse.id, feedback: 'สีรายงานยังผิด' })
      return { p, wi }
    }

    it('PM reopens to dev: root tasks redone with the change request, close tasks rejected, later steps redone', async () => {
      const { wi } = await changesRequested()
      const res = await reopen(pm, wi.id, 'dev')
      expect(res.statusCode).toBe(200)
      const d = res.json() as WorkItemDetail
      expect(d.currentStepKey).toBe('dev')
      expect(d.steps.map((s) => s.status)).toEqual(['done', 'current', 'pending', 'pending'])

      const latest = (key: string) => d.tasks.filter((t) => t.templateTaskKey === key).at(-1)!
      expect(latest('implement')).toMatchObject({ attempt: 2, state: 'open', feedback: 'สีรายงานยังผิด', assigneeId: dev.id, executor: 'human' })
      expect(latest('draft-tests')).toMatchObject({ attempt: 2, state: 'open', feedback: 'สีรายงานยังผิด', assigneeId: qc.id })
      // Non-root tasks wait for their dependencies again.
      expect(latest('review-code')).toMatchObject({ attempt: 1, state: 'accepted' })
      expect(latest('accept-delivery')).toMatchObject({ attempt: 2, state: 'rejected' })
      expect(d.tasks.filter((t) => ['accept-delivery', 'close-bug'].includes(t.templateTaskKey)).every((t) => t.state !== 'open')).toBe(true)
      const rejected = d.events.filter((e) => e.type === 'task.rejected' && e.reason === 'reopened')
      expect(rejected.map((e) => e.taskId)).toEqual([latest('accept-delivery').id])
      expect(d.events.filter((e) => e.type === 'work_item.reopened').map((e) => [e.payload, e.actorId])).toEqual([[{ from: 'close', to: 'dev' }, pm.id]])

      // Reopening to the current or a later step, or an unknown one, is refused.
      for (const step of ['dev', 'qc', 'close', 'nope']) {
        const bad = await reopen(pm, wi.id, step)
        expect(bad.statusCode).toBe(422)
        expect(bad.json()).toEqual({ error: 'invalid_state' })
      }
      expect((await call(pm, 'POST', `/work-items/${wi.id}/reopen`, {})).statusCode).toBe(400)

      // The whole step is redone: the code review comes back, and QC is not skipped.
      await drive(wi.id, 'implement', dev, { text: 'แก้สีแล้ว' })
      await drive(wi.id, 'draft-tests', qc, { text: 't2' })
      expect((await detail(pm, wi.id)).currentStepKey).toBe('dev')
      expect(await active(pm, wi.id, 'review-code')).toMatchObject({ attempt: 2, state: 'open' })
      await drive(wi.id, 'review-code', dev, approve)
      expect((await detail(pm, wi.id)).currentStepKey).toBe('qc')
      expect(await active(pm, wi.id, 'verify')).toMatchObject({ attempt: 2, state: 'open' })
      await drive(wi.id, 'verify', qc, { text: 'ok' })
      await drive(wi.id, 'approve-release', qc, approve)
      expect(await active(pm, wi.id, 'accept-delivery')).toMatchObject({ attempt: 3, state: 'open', assigneeId: nurse.id })
    })

    it('only the PM or an admin may reopen; non-members get 404; pending step advances are superseded', async () => {
      const { wi } = await changesRequested()
      expect((await reopen(dev, wi.id, 'dev')).statusCode).toBe(403)
      expect((await reopen(nurse, wi.id, 'dev')).statusCode).toBe(403)
      expect((await reopen(outsider, wi.id, 'dev')).statusCode).toBe(404)
      expect((await reopen(pm, NO_ID, 'dev')).statusCode).toBe(404)
      expect((await detail(pm, wi.id)).currentStepKey).toBe('close')

      // Back to dev, finish it, and leave the advance to QC pending: reopening supersedes it.
      expect((await reopen(admin, wi.id, 'dev')).statusCode).toBe(200)
      await drive(wi.id, 'implement', dev, { text: 'x' })
      await drive(wi.id, 'draft-tests', qc, { text: 't' })
      const review = await active(pm, wi.id, 'review-code')
      expect((await call(dev, 'POST', `/tasks/${review.id}/submit`, approve)).statusCode).toBe(200)
      const pending = (await todo(pm)).proposals.filter((x) => x.workItemId === wi.id && x.kind === 'step_advance')
      expect(pending).toHaveLength(1)
      expect((await reopen(pm, wi.id, 'intake')).statusCode).toBe(200)
      expect((await todo(pm)).proposals.filter((x) => x.workItemId === wi.id)).toEqual([])
      const d = await detail(pm, wi.id)
      expect(d.currentStepKey).toBe('intake')
      expect(d.events.some((e) => e.type === 'proposal.superseded')).toBe(true)
      // No requester change request after the last one? The latest REQUESTER rejection is still the feedback.
      expect(await active(pm, wi.id, 'accept-bug')).toMatchObject({ attempt: 2, state: 'open', feedback: 'สีรายงานยังผิด' })

      // A cancelled item cannot be reopened.
      expect((await call(pm, 'POST', `/work-items/${wi.id}/cancel`)).statusCode).toBe(200)
      expect((await reopen(pm, wi.id, 'intake')).statusCode).toBe(409)
    })
  })
})
