import type { FastifyInstance } from 'fastify'
import type { Me, Proposal, Todo, WorkItemDetail } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, eq } from 'drizzle-orm'
import { events, proposals, tasks, workItems } from '../src/db/schema.js'
import { createProposal, decideProposal } from '../src/proposals/service.js'
import { runWork } from '../src/work/context.js'
import { progressWorkItem, submitTask } from '../src/work/engine.js'
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

const asMe = (w: Who, name: string): Me => ({ id: w.id, username: name, displayName: name, email: null, isStaff: true, isAdmin: false })

async function project(autonomy: 'propose' | 'auto-assign' = 'propose'): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name: 'ระบบรายงานแล็บ' })).json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [pm2, ['PM']], [dev, ['DEV']], [ba, ['BA']]] as [Who, string[]][]) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  if (autonomy !== 'propose') expect((await call(pm, 'PATCH', `/projects/${id}`, { autonomy })).statusCode).toBe(200)
  return id
}

async function createItem(projectId: string, templateKey = 'software-change'): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'เพิ่มรายงาน HbA1c', templateKey })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const detail = async (id: string): Promise<WorkItemDetail> => (await call(pm, 'GET', `/work-items/${id}`)).json()
const todo = async (who: Who): Promise<Todo> => (await call(who, 'GET', '/me/todo')).json()

/** Approves the intake task (assigning it to the PM first when it was only proposed). */
async function finishIntake(wi: WorkItemDetail) {
  const t = wi.tasks[0]!
  if (t.assigneeId !== pm.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
  expect((await call(pm, 'POST', `/tasks/${t.id}/submit`, { text: '', decision: 'approve' })).statusCode).toBe(200)
}

async function rows(workItemId: string) {
  const db = await testDb()
  return db.select().from(proposals).where(eq(proposals.workItemId, workItemId)).orderBy(asc(proposals.createdAt))
}

async function itemEvents(workItemId: string) {
  const db = await testDb()
  return db.select().from(events).where(eq(events.workItemId, workItemId)).orderBy(asc(events.seq))
}

const advancedFrom = async (workItemId: string, from: string) =>
  (await itemEvents(workItemId)).filter(
    (e) => e.type === 'work_item.step_advanced' && (e.payload as { from: string }).from === from,
  )

const decide = (who: Who, id: string, body: Record<string, unknown> = { decision: 'accept' }) =>
  call(who, 'POST', `/proposals/${id}/decide`, body)

describe('proposals', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true, name: 'สมศรี' })
    pm2 = await login(app, 'pm2', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    ba = await login(app, 'ba', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('a finished step in a propose project waits for the PM; accepting advances it', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)

    const d = await detail(wi.id)
    expect(d.currentStepKey).toBe('intake')
    expect(d.tasks.filter((t) => t.stepKey === 'ba')).toEqual([])
    const pending = await rows(wi.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      kind: 'step_advance',
      state: 'pending',
      projectId: p,
      payload: { fromStep: 'intake', toStep: 'ba' },
      createdByKind: 'system',
    })
    const created = (await itemEvents(wi.id)).filter((e) => e.type === 'proposal.created')
    expect(created.map((e) => e.actorKind)).toEqual(['system'])

    const mine = await todo(pm)
    expect(mine.proposals.map((x) => x.id)).toEqual([pending[0]!.id])
    expect((await todo(dev)).proposals).toEqual([])
    const listed = (await call(dev, 'GET', `/proposals?projectId=${p}&state=pending`)).json() as Proposal[]
    expect(listed.map((x) => x.id)).toEqual([pending[0]!.id])
    expect((await call(outsider, 'GET', `/proposals?projectId=${p}`)).statusCode).toBe(404)
    expect((await call(nurse, 'GET', '/proposals')).statusCode).toBe(403)

    const res = await decide(pm, pending[0]!.id, { decision: 'accept', note: 'ไปต่อ' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: pending[0]!.id, state: 'accepted', decidedById: pm.id, decidedByName: 'สมศรี' })
    const after = await detail(wi.id)
    expect(after.currentStepKey).toBe('ba')
    expect(after.tasks.map((t) => t.templateTaskKey)).toContain('draft-requirements')
    expect((await todo(pm)).proposals).toEqual([])
    const types = (await itemEvents(wi.id)).map((e) => e.type)
    expect(types).toContain('proposal.accepted')
    // Already decided.
    expect((await decide(pm2, pending[0]!.id)).statusCode).toBe(409)
  })

  it('only the project PMs or admins decide: DEV member 403, outsider 404, requester 403', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    const denied = await decide(dev, prop!.id)
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ error: 'forbidden' })
    expect((await decide(outsider, prop!.id)).statusCode).toBe(404)
    expect((await decide(nurse, prop!.id)).statusCode).toBe(403)
    expect((await decide(pm, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
    expect((await rows(wi.id))[0]!.state).toBe('pending')
    // Admins decide anything; rejecting leaves the step where it is.
    const rejected = await decide(admin, prop!.id, { decision: 'reject', note: 'ยังไม่พร้อม' })
    expect(rejected.statusCode).toBe(200)
    expect(rejected.json()).toMatchObject({ state: 'rejected' })
    expect((await rows(wi.id))[0]!.decisionNote).toBe('ยังไม่พร้อม')
    expect((await detail(wi.id)).currentStepKey).toBe('intake')
  })

  it('two PMs accepting at once: one 200, one 409, one advance', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    const results = await Promise.all([decide(pm, prop!.id), decide(pm2, prop!.id)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await advancedFrom(wi.id, 'intake')).toHaveLength(1)
    const db = await testDb()
    const drafts = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workItemId, wi.id), eq(tasks.templateTaskKey, 'draft-requirements')))
    expect(drafts).toHaveLength(1)
    expect((await rows(wi.id))[0]).toMatchObject({ state: 'accepted' })
  })

  it('two PMs accepting in overlapping transactions apply once (the second waits, then 409)', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    let arrived = 0
    let release!: () => void
    const bothOpen = new Promise<void>((r) => (release = r))
    const accept = (who: Who, name: string) =>
      runWork(app.deps, { id: who.id, kind: 'person' }, async (ctx) => {
        if (++arrived === 2) release()
        await bothOpen
        return decideProposal(ctx, asMe(who, name), prop!.id, { decision: 'accept' })
      })
    const settled = await Promise.allSettled([accept(pm, 'pm'), accept(pm2, 'pm2')])
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected'])
    const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ statusCode: 409, body: { error: 'invalid_state' } })
    expect(await advancedFrom(wi.id, 'intake')).toHaveLength(1)
    expect((await detail(wi.id)).currentStepKey).toBe('ba')
  })

  it('cancelling the work item supersedes its proposal; accepting then → 409', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    expect((await call(pm, 'POST', `/work-items/${wi.id}/cancel`)).statusCode).toBe(200)
    const res = await decide(pm, prop!.id)
    expect(res.statusCode).toBe(409)
    expect((await rows(wi.id))[0]).toMatchObject({ state: 'superseded' })
    expect((await itemEvents(wi.id)).map((e) => e.type)).toContain('proposal.superseded')
    expect((await todo(pm)).proposals).toEqual([])
  })

  it('a step advance whose situation changed is superseded on accept (409, committed)', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [real] = await rows(wi.id)
    // A stale proposal for a step the item is not on.
    const stale = await runWork(app.deps, { id: null, kind: 'system' }, (ctx) =>
      createProposal(ctx, {
        projectId: p,
        workItemId: wi.id,
        kind: 'priority_change',
        summary: '',
        reason: '',
        payload: { priority: 'urgent' },
        onBehalfOf: null,
      }),
    )
    const db = await testDb()
    await db.update(proposals).set({ state: 'rejected' }).where(eq(proposals.id, real!.id))
    await db.update(proposals).set({ kind: 'step_advance', payload: { fromStep: 'ba', toStep: 'sa' } }).where(eq(proposals.id, stale))
    const res = await decide(pm, stale)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invalid_state' })
    const [row] = await db.select().from(proposals).where(eq(proposals.id, stale))
    expect(row).toMatchObject({ state: 'superseded', decidedBy: null })
    expect((await detail(wi.id)).currentStepKey).toBe('intake')
  })

  it('concurrent sibling completions in a propose project create one proposal', async () => {
    const p = await project()
    const wi = await createItem(p, 'bug-fix')
    await finishIntake(wi)
    expect(await decide(pm, (await rows(wi.id))[0]!.id)).toMatchObject({ statusCode: 200 })
    const key = async (k: string) => (await detail(wi.id)).tasks.find((t) => t.templateTaskKey === k)!
    for (const k of ['implement', 'draft-tests']) {
      expect((await call(pm, 'POST', `/tasks/${(await key(k)).id}/assign`, { personId: dev.id })).statusCode).toBe(200)
    }
    await call(dev, 'POST', `/tasks/${(await key('implement')).id}/submit`, { text: 'code' })
    const review = await key('review-code')
    await call(pm, 'POST', `/tasks/${review.id}/assign`, { personId: pm.id })
    const draft = await key('draft-tests')
    let arrived = 0
    let release!: () => void
    const bothOpen = new Promise<void>((r) => (release = r))
    const submit = (who: Who, name: string, taskId: string, decision?: 'approve') =>
      runWork(app.deps, { id: who.id, kind: 'person' }, async (ctx) => {
        if (++arrived === 2) release()
        await bothOpen
        await submitTask(ctx, asMe(who, name), taskId, { text: 't', attachmentIds: [], decision })
      })
    await Promise.all([submit(pm, 'pm', review.id, 'approve'), submit(dev, 'dev', draft.id)])
    const props = (await rows(wi.id)).filter((r) => r.state === 'pending')
    expect(props).toHaveLength(1)
    expect(props[0]!.payload).toEqual({ fromStep: 'dev', toStep: 'qc' })
    expect((await detail(wi.id)).currentStepKey).toBe('dev')
  })

  it('auto-assign projects advance without proposals', async () => {
    const p = await project('auto-assign')
    const wi = await createItem(p)
    await finishIntake(wi)
    expect((await detail(wi.id)).currentStepKey).toBe('ba')
    expect(await rows(wi.id)).toEqual([])
  })

  it('the final step completes the work item without a proposal', async () => {
    const p = await project()
    const wi = await createItem(p, 'bug-fix')
    const db = await testDb()
    // Jump straight to the last step: its tasks appear, then finishing them completes the item.
    await db.update(workItems).set({ currentStepKey: 'close' }).where(eq(workItems.id, wi.id))
    await db.delete(tasks).where(eq(tasks.workItemId, wi.id))
    await runWork(app.deps, { id: null, kind: 'system' }, (ctx) => progressWorkItem(ctx, wi.id))
    for (const k of ['accept-delivery', 'close-bug']) {
      const t = (await detail(wi.id)).tasks.find((x) => x.templateTaskKey === k)!
      if (t.assigneeId !== pm.id) await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })
      expect((await call(pm, 'POST', `/tasks/${t.id}/submit`, { text: '', decision: 'approve' })).statusCode).toBe(200)
    }
    expect((await detail(wi.id)).state).toBe('done')
    expect(await rows(wi.id)).toEqual([])
  })

  it('accepting a priority_change sets the priority and records work_item.priority_changed', async () => {
    const p = await project()
    const wi = await createItem(p)
    const id = await runWork(app.deps, { id: dev.id, kind: 'ai' }, (ctx) =>
      createProposal(ctx, {
        projectId: p,
        workItemId: wi.id,
        kind: 'priority_change',
        summary: 'ด่วน',
        reason: 'ผู้ใช้รอ',
        payload: { priority: 'urgent' },
        onBehalfOf: dev.id,
      }),
    )
    expect((await rows(wi.id))[0]).toMatchObject({ createdByKind: 'ai', onBehalfOf: dev.id })
    expect((await todo(pm)).proposals.map((x) => x.kind)).toEqual(['priority_change'])
    expect((await decide(dev, id)).statusCode).toBe(403)
    const res = await decide(pm, id)
    expect(res.statusCode).toBe(200)
    expect((await detail(wi.id)).priority).toBe('urgent')
    const changed = (await itemEvents(wi.id)).filter((e) => e.type === 'work_item.priority_changed')
    expect(changed.map((e) => e.payload)).toEqual([{ from: 'normal', to: 'urgent', proposalId: id }])
  })

  it('accepting a project-less create_work_item proposal needs a project; returns the new work item', async () => {
    const p = await project()
    const id = await runWork(app.deps, { id: dev.id, kind: 'ai' }, (ctx) =>
      createProposal(ctx, {
        projectId: null,
        workItemId: null,
        kind: 'create_work_item',
        summary: 'แจ้งปัญหา',
        reason: '',
        payload: { title: 'รายงานช้า', description: 'เปิดนาน', templateKey: 'bug-fix', priority: 'high' },
        onBehalfOf: nurse.id,
      }),
    )
    // PMs (of any project) and admins see it; others do not.
    expect((await todo(pm)).proposals.map((x) => x.id)).toEqual([id])
    expect((await todo(dev)).proposals).toEqual([])
    expect((await decide(outsider, id, { decision: 'accept', projectId: p })).statusCode).toBe(404)
    const missing = await decide(pm, id)
    expect(missing.statusCode).toBe(422)
    expect(missing.json()).toEqual({ error: 'project_required' })

    const res = await decide(pm, id, { decision: 'accept', projectId: p })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Proposal
    expect(body).toMatchObject({ state: 'accepted', projectId: p })
    expect(body.workItemId).toBeTruthy()
    // The requester is not a member: the deciding PM creates it, with them as the requester.
    const item = await detail(body.workItemId!)
    expect(item).toMatchObject({ title: 'รายงานช้า', priority: 'high', projectId: p, ownerId: pm.id, requesterId: nurse.id })
  })

  it('a create_work_item proposal made for a member may be accepted by that member', async () => {
    const p = await project()
    const id = await runWork(app.deps, { id: dev.id, kind: 'ai' }, (ctx) =>
      createProposal(ctx, {
        projectId: null,
        workItemId: null,
        kind: 'create_work_item',
        summary: '',
        reason: '',
        payload: { projectId: p, title: 'ปรับหน้าจอ', templateKey: 'bug-fix' },
        onBehalfOf: dev.id,
      }),
    )
    expect((await todo(dev)).proposals.map((x) => x.id)).toEqual([id])
    const res = await decide(dev, id)
    expect(res.statusCode).toBe(200)
    const item = await detail((res.json() as Proposal).workItemId!)
    expect(item).toMatchObject({ ownerId: dev.id, projectId: p })
    const created = (await itemEvents(item.id)).find((e) => e.type === 'work_item.created')!
    expect(created.actorId).toBe(dev.id)
  })

  it('rejecting a step advance needs a note; the item then awaits a direct advance by the PM', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    expect((await detail(wi.id)).awaitingAdvance).toBe(false)

    for (const body of [{ decision: 'reject' }, { decision: 'reject', note: '   ' }]) {
      const bad = await decide(pm, prop!.id, body)
      expect(bad.statusCode).toBe(422)
      expect(bad.json()).toEqual({ error: 'comment_required' })
    }
    expect((await rows(wi.id))[0]!.state).toBe('pending')
    expect((await decide(pm, prop!.id, { decision: 'reject', note: 'รอผู้ใช้ยืนยันก่อน' })).statusCode).toBe(200)

    const stuck = await detail(wi.id)
    expect(stuck).toMatchObject({ currentStepKey: 'intake', awaitingAdvance: true })
    const listed = (await call(pm, 'GET', `/projects/${p}/work-items`)).json() as { id: string; awaitingAdvance: boolean }[]
    expect(listed.find((x) => x.id === wi.id)!.awaitingAdvance).toBe(true)

    expect((await call(dev, 'POST', `/work-items/${wi.id}/advance`)).statusCode).toBe(403)
    expect((await call(outsider, 'POST', `/work-items/${wi.id}/advance`)).statusCode).toBe(404)
    expect((await call(nurse, 'POST', `/work-items/${wi.id}/advance`)).statusCode).toBe(403)

    const res = await call(pm, 'POST', `/work-items/${wi.id}/advance`)
    expect(res.statusCode).toBe(200)
    const after = res.json() as WorkItemDetail
    expect(after).toMatchObject({ currentStepKey: 'ba', awaitingAdvance: false })
    expect(after.tasks.map((t) => t.templateTaskKey)).toContain('draft-requirements')
    const advanced = await advancedFrom(wi.id, 'intake')
    expect(advanced.map((e) => [e.actorKind, e.actorId])).toEqual([['person', pm.id]])
    // Now mid-step: not ready.
    const again = await call(pm, 'POST', `/work-items/${wi.id}/advance`)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'invalid_state' })
  })

  it('advancing directly supersedes a pending step_advance proposal', async () => {
    const p = await project()
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    // A pending proposal: not awaitingAdvance (the proposal is the way forward), but the PM may still advance.
    expect((await detail(wi.id)).awaitingAdvance).toBe(false)
    expect((await call(admin, 'POST', `/work-items/${wi.id}/advance`)).statusCode).toBe(200)
    expect((await rows(wi.id))[0]).toMatchObject({ id: prop!.id, state: 'superseded' })
    expect((await decide(pm, prop!.id)).statusCode).toBe(409)
    expect(await advancedFrom(wi.id, 'intake')).toHaveLength(1)
  })

  it('advancing a work item that is not ready → 409', async () => {
    const p = await project()
    const wi = await createItem(p)
    expect((await call(pm, 'POST', `/work-items/${wi.id}/advance`)).statusCode).toBe(409)
    expect((await call(pm, 'POST', '/work-items/00000000-0000-4000-8000-000000000000/advance')).statusCode).toBe(404)
  })

  it('a decision naming another project than the proposal\'s → 422 invalid_state', async () => {
    const p = await project()
    const other = (await call(admin, 'POST', '/projects', { name: 'อื่น' })).json() as { id: string }
    const wi = await createItem(p)
    await finishIntake(wi)
    const [prop] = await rows(wi.id)
    const res = await decide(pm, prop!.id, { decision: 'accept', projectId: other.id })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'invalid_state' })
    expect((await rows(wi.id))[0]!.state).toBe('pending')
    expect((await decide(pm, prop!.id, { decision: 'accept', projectId: p })).statusCode).toBe(200)
  })
})
