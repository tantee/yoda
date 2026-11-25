import type { FastifyInstance } from 'fastify'
import type { Task, WorkItemDetail } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { events, knowledgeEntries, mergeRequests, notifications, projectRepos, proposals, tasks, workItemRepos } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

// Obviously fake test value; never a real secret.
const SECRET = 'fake-webhook-secret-for-tests'
const PATHS: Record<number, string> = { 11: 'dept/lab-report', 12: 'dept/lab-web' }

let app: FastifyInstance
let fake: FakeGitLab
let jobs: InlineJobQueue
let failures: string[]
let sent: { name: string; id: string }[]
let admin: Who
let pm: Who
let dev: Who
let projectId: string
let uuidSeq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })
const approve = { text: '', decision: 'approve' }

/** Delivers a merge_request hook and runs the jobs it queued (gitlab-mr-effect included). */
async function mrHook(o: { workItemId: string; project?: number; iid?: number; state?: string }) {
  const project = o.project ?? 11
  const iid = o.iid ?? 5
  const res = await app.inject({
    method: 'POST',
    url: '/gitlab/webhook',
    headers: { 'content-type': 'application/json', 'x-gitlab-token': SECRET, 'x-gitlab-event-uuid': `fake-uuid-${++uuidSeq}` },
    payload: JSON.stringify({
      object_kind: 'merge_request',
      project: { id: project, path_with_namespace: PATHS[project] },
      user: { id: 7, username: 'somchai.dev' },
      object_attributes: {
        iid,
        title: `Fix ${iid}`,
        url: `http://gitlab.example.test/${PATHS[project]}/-/merge_requests/${iid}`,
        state: o.state ?? 'opened',
        source_branch: `yoda/${o.workItemId.slice(0, 8)}-fix-${iid}`,
        description: '',
      },
    }),
  })
  expect(res.statusCode).toBe(200)
  await jobs.drain()
}

async function setup(opts: { repos: number[]; autonomy?: 'propose' | 'auto-assign' }) {
  fake = await startFakeGitLab()
  for (const p of opts.repos) fake.addProject(PATHS[p]!, p)
  failures = []
  // This file opts in to gitlab-issue-sync and gitlab-mr-effect (the default test queue drops both).
  jobs = new InlineJobQueue({
    onError: (err, name, id) => {
      failures.push(`${name} ${id}`)
      console.warn(err)
    },
    ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief'],
  })
  sent = []
  const send = jobs.send.bind(jobs)
  jobs.send = async (name, data) => {
    sent.push({ name, id: data.id })
    return send(name, data)
  }
  app = await makeApp({ jobs, gitlab: new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }) })
  app.deps.config.gitlabWebhookSecret = SECRET
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  projectId = ((await call(admin, 'POST', '/projects', { name: 'ระบบแล็บ' })).json() as { id: string }).id
  await call(admin, 'PUT', `/projects/${projectId}/members/${pm.id}`, { roles: ['PM'] })
  await call(admin, 'PUT', `/projects/${projectId}/members/${dev.id}`, { roles: ['DEV', 'QC'] })
  if (opts.autonomy) expect((await call(admin, 'PATCH', `/projects/${projectId}`, { autonomy: opts.autonomy })).statusCode).toBe(200)
  for (const p of opts.repos) {
    expect((await call(pm, 'POST', `/projects/${projectId}/repos`, { path: PATHS[p] })).statusCode).toBe(201)
  }
}

const detail = async (id: string) => (await call(pm, 'GET', `/work-items/${id}`)).json() as WorkItemDetail
const attempts = async (id: string, key: string): Promise<Task[]> => (await detail(id)).tasks.filter((t) => t.templateTaskKey === key)
const latest = async (id: string, key: string): Promise<Task | undefined> => (await attempts(id, key)).at(-1)

async function submit(id: string, key: string, who: Who, result: Record<string, unknown>) {
  const t = (await latest(id, key))!
  if (t.assigneeId !== who.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  const res = await call(who, 'POST', `/tasks/${t.id}/submit`, result)
  expect(res.statusCode).toBe(200)
}

/** A bug-fix work item in the Dev step (implement and draft-tests open), with its GitLab issues created. */
async function itemInDev(): Promise<string> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'แก้รายงานแล็บ', description: 'ผลแล็บไม่แสดง', templateKey: 'bug-fix' })
  expect(res.statusCode).toBe(201)
  const id = (res.json() as { id: string }).id
  await submit(id, 'accept-bug', pm, approve)
  await acceptStepAdvance(app, pm, id)
  await jobs.drain()
  expect((await detail(id)).currentStepKey).toBe('dev')
  return id
}

const accepted = async (workItemId: string, reason: string) =>
  app.deps.db
    .select()
    .from(events)
    .where(and(eq(events.workItemId, workItemId), eq(events.type, 'task.accepted'), eq(events.reason, reason)))
const pendingAdvance = async (workItemId: string) =>
  app.deps.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workItemId, workItemId), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
const mrRow = async (iid: number) => (await app.deps.db.select().from(mergeRequests).where(eq(mergeRequests.mrIid, iid)))[0]!
const rerun = async (iid: number) => {
  await jobs.send('gitlab-mr-effect', { id: (await mrRow(iid)).id })
  await jobs.drain()
}

beforeEach(async () => {
  await resetDb(await testDb())
})
afterEach(async () => {
  await jobs?.drain()
  await app?.close()
  await fake?.stop()
  expect(failures).toEqual([])
})

describe('merge request effects', () => {
  describe('one repo, propose', () => {
    beforeEach(() => setup({ repos: [11] }))

    it('an opened MR accepts the implement task; the merge approves the review and proposes the advance', async () => {
      const id = await itemInDev()
      const impl = (await latest(id, 'implement'))!
      expect(impl).toMatchObject({ state: 'open', executor: 'ai', assigneeId: null })

      await mrHook({ workItemId: id })
      const done = (await latest(id, 'implement'))!
      expect(done.id).toBe(impl.id)
      expect(done.state).toBe('accepted')
      expect(done.result?.text).toContain('http://gitlab.example.test/dept/lab-report/-/merge_requests/5')
      const [ev] = await accepted(id, 'mr_opened_in_gitlab')
      expect(ev).toMatchObject({ taskId: impl.id, actorId: null, actorKind: 'system' })
      // The review of the code now exists and is still for a person to decide (or the merge).
      const review = (await latest(id, 'review-code'))!
      expect(['proposed', 'open']).toContain(review.state)

      // Re-running the same state changes nothing.
      await rerun(5)
      expect(await accepted(id, 'mr_opened_in_gitlab')).toHaveLength(1)

      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
      await mrHook({ workItemId: id, state: 'merged' })
      const approved = (await latest(id, 'review-code'))!
      expect(approved.id).toBe(review.id)
      expect(approved.state).toBe('accepted')
      expect(approved.result).toMatchObject({ decision: 'approve' })
      expect(approved.result?.text).toMatch(/^Merged in GitLab: /)
      const [rev] = await accepted(id, 'merged_in_gitlab')
      expect(rev).toMatchObject({ taskId: review.id, actorId: null, actorKind: 'system' })
      // Knowledge as for a person's approval: the implement result becomes a confirmed document.
      const docs = await app.deps.db
        .select()
        .from(knowledgeEntries)
        .where(and(eq(knowledgeEntries.workItemId, id), eq(knowledgeEntries.sourceRef, impl.id), eq(knowledgeEntries.type, 'document')))
      expect(docs).toHaveLength(1)
      expect(docs[0]!.status).toBe('confirmed')
      expect(docs[0]!.createdBy).toBeNull()
      // propose: the step waits for the PM.
      expect((await detail(id)).currentStepKey).toBe('dev')
      expect(await pendingAdvance(id)).toHaveLength(1)

      // Replaying the merged effect: no second acceptance, no second proposal.
      await rerun(5)
      await mrHook({ workItemId: id, state: 'merged' })
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(1)
      expect(await accepted(id, 'mr_opened_in_gitlab')).toHaveLength(1)
      expect(await pendingAdvance(id)).toHaveLength(1)
    })

    it('a merge without an earlier opened delivery accepts implement and review in one go', async () => {
      const id = await itemInDev()
      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
      await mrHook({ workItemId: id, state: 'merged' })
      expect((await latest(id, 'implement'))!.state).toBe('accepted')
      expect((await latest(id, 'review-code'))!.state).toBe('accepted')
      expect(await pendingAdvance(id)).toHaveLength(1)
    })

    it('an implement task a person holds is accepted too', async () => {
      const id = await itemInDev()
      const impl = (await latest(id, 'implement'))!
      expect((await call(pm, 'POST', `/tasks/${impl.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
      expect((await call(dev, 'POST', `/tasks/${impl.id}/start`)).statusCode).toBe(200)
      await mrHook({ workItemId: id })
      expect((await latest(id, 'implement'))!).toMatchObject({ id: impl.id, state: 'accepted', executor: 'human' })
    })

    it('rework pushed to the same MR: its merge accepts the new attempt and approves the new review', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id })
      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
      await submit(id, 'review-code', dev, { text: 'ต้องแก้ query', decision: 'changes' })
      expect((await attempts(id, 'implement')).map((t) => t.state)).toEqual(['accepted', 'open'])
      // The same opened MR never accepts the rework by itself.
      await rerun(5)
      expect((await attempts(id, 'implement')).map((t) => t.state)).toEqual(['accepted', 'open'])

      await mrHook({ workItemId: id, state: 'merged' })
      expect((await attempts(id, 'implement')).map((t) => t.state)).toEqual(['accepted', 'accepted'])
      expect((await attempts(id, 'review-code')).map((t) => t.state)).toEqual(['rejected', 'accepted'])
      expect(await pendingAdvance(id)).toHaveLength(1)

      await rerun(5)
      expect(await accepted(id, 'mr_opened_in_gitlab')).toHaveLength(2)
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(1)
      expect(await pendingAdvance(id)).toHaveLength(1)
    })

    it('rework in a new MR: its opening accepts the new attempt, its merge approves the new review', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id })
      await submit(id, 'review-code', dev, { text: 'ต้องแก้ query', decision: 'changes' })
      await mrHook({ workItemId: id, iid: 5, state: 'closed' })
      await mrHook({ workItemId: id, iid: 6 })
      expect((await attempts(id, 'implement')).map((t) => t.state)).toEqual(['accepted', 'accepted'])
      const reviews = await attempts(id, 'review-code')
      expect(reviews.map((t) => t.state)).toEqual(['rejected', reviews[1]!.state])
      expect(reviews[1]!.state).not.toBe('accepted')
      await mrHook({ workItemId: id, iid: 6, state: 'merged' })
      expect((await latest(id, 'review-code'))!.state).toBe('accepted')
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(1)
    })

    it('an MR closed without merge notifies the PM and the implement assignee, tasks unchanged', async () => {
      const id = await itemInDev()
      const impl = (await latest(id, 'implement'))!
      expect((await call(pm, 'POST', `/tasks/${impl.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
      await mrHook({ workItemId: id, iid: 7, state: 'closed' })
      const before = await app.deps.db.select().from(tasks).where(eq(tasks.workItemId, id))
      expect((await latest(id, 'implement'))!.state).toBe('open')
      const mrId = (await mrRow(7)).id
      const notes = await app.deps.db.select().from(notifications).where(eq(notifications.dedupeKey, `mr-closed:${mrId}`))
      expect(notes.map((n) => n.personId).sort()).toEqual([pm.id, dev.id].sort())
      expect(notes[0]!.kind).toBe('work_item_stuck')
      await rerun(7)
      expect(await app.deps.db.select().from(notifications).where(eq(notifications.dedupeKey, `mr-closed:${mrId}`))).toHaveLength(2)
      expect(await app.deps.db.select().from(tasks).where(eq(tasks.workItemId, id))).toEqual(before)
    })

    it('an open discussion holds the step: the review is approved, the advance waits for the decision', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id })
      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
      const raised = await call(pm, 'POST', '/discussions', { workItemId: id, question: 'ต้องย้ายฐานข้อมูลก่อนไหม', requestBrief: false })
      expect(raised.statusCode).toBe(201)
      const discussionId = (raised.json() as { id: string }).id

      await mrHook({ workItemId: id, state: 'merged' })
      expect((await latest(id, 'review-code'))!.state).toBe('accepted')
      expect((await detail(id)).currentStepKey).toBe('dev')
      expect(await pendingAdvance(id)).toHaveLength(0)

      expect((await call(pm, 'POST', `/discussions/${discussionId}/decide`, { decision: 'ย้ายทีหลัง' })).statusCode).toBe(200)
      await jobs.drain()
      expect(await pendingAdvance(id)).toHaveLength(1)
    })
  })

  describe('one repo, auto-assign', () => {
    beforeEach(() => setup({ repos: [11], autonomy: 'auto-assign' }))

    it('the merge advances the item to QC and assigns its task', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id })
      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
      await mrHook({ workItemId: id, state: 'merged' })
      const d = await detail(id)
      expect(d.currentStepKey).toBe('qc')
      expect(d.tasks.find((t) => t.templateTaskKey === 'verify')).toMatchObject({ state: 'open', assigneeId: dev.id })
      expect(await pendingAdvance(id)).toHaveLength(0)
    })
  })

  describe('two repos', () => {
    beforeEach(() => setup({ repos: [11, 12] }))

    it('approves the review only once every repo has a merged MR', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id, project: 11, iid: 5 })
      await mrHook({ workItemId: id, project: 12, iid: 8 })
      expect(await accepted(id, 'mr_opened_in_gitlab')).toHaveLength(1)
      await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })

      await mrHook({ workItemId: id, project: 11, iid: 5, state: 'merged' })
      expect((await latest(id, 'review-code'))!.state).not.toBe('accepted')
      // A closed MR in the other repo doesn't count as merged.
      await mrHook({ workItemId: id, project: 12, iid: 9, state: 'closed' })
      expect((await latest(id, 'review-code'))!.state).not.toBe('accepted')

      await mrHook({ workItemId: id, project: 12, iid: 8, state: 'merged' })
      expect((await latest(id, 'review-code'))!.state).toBe('accepted')
      await rerun(5)
      await rerun(8)
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(1)
      expect(await pendingAdvance(id)).toHaveLength(1)
    })

    it('a merge older than the rework accepts nothing when replayed', async () => {
      const id = await itemInDev()
      await mrHook({ workItemId: id, project: 11, iid: 5 })
      await mrHook({ workItemId: id, project: 12, iid: 8, state: 'merged' })
      await submit(id, 'review-code', dev, { text: 'ต้องแก้ query', decision: 'changes' })
      await rerun(8)
      expect((await attempts(id, 'implement')).map((t) => t.state)).toEqual(['accepted', 'open'])
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(0)
    })

    it('unlinking the repo still waiting for a merge approves the review', async () => {
      const id = await itemInDev()
      const [b] = await app.deps.db.select().from(projectRepos).where(eq(projectRepos.gitlabProjectId, 12))
      await mrHook({ workItemId: id, project: 11, iid: 5 })
      await mrHook({ workItemId: id, project: 11, iid: 5, state: 'merged' })
      expect((await latest(id, 'review-code'))!.state).not.toBe('accepted')
      // As if its issue was never created (e.g. sync failing), so the PM may remove the repo.
      await app.deps.db.update(workItemRepos).set({ issueIid: null, issueUrl: null }).where(eq(workItemRepos.repoId, b!.id))
      expect((await call(pm, 'DELETE', `/projects/${projectId}/repos/${b!.id}`)).statusCode).toBe(204)
      await jobs.drain()
      expect((await latest(id, 'review-code'))!.state).toBe('accepted')
      expect(await accepted(id, 'merged_in_gitlab')).toHaveLength(1)
    })

    it('narrowing the repos of an item queues the effect of its merged MR', async () => {
      const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'แก้รายงานแล็บ', description: 'ผลแล็บไม่แสดง', templateKey: 'bug-fix' })
      const id = (res.json() as { id: string }).id
      await mrHook({ workItemId: id, project: 11, iid: 5, state: 'merged' })
      const [a] = await app.deps.db.select().from(projectRepos).where(eq(projectRepos.gitlabProjectId, 11))
      sent.length = 0
      expect((await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a!.id] })).statusCode).toBe(200)
      await jobs.drain()
      expect(sent).toContainEqual({ name: 'gitlab-mr-effect', id: (await mrRow(5)).id })
    })
  })
})
