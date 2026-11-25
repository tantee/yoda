import type { FastifyInstance } from 'fastify'
import type { LiveEvent, Repo, Task, TaskWithContext, WorkItemCode, WorkItemDetail } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { events, workItemRepos } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { HEADINGS, ISSUE_BEGIN, ISSUE_END } from '../src/gitlab/issue-section.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { personAsMe } from '../src/proposals/service.js'
import { deliverable } from '../src/routes/stream.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

// Obviously fake test value; never a real secret.
const SECRET = 'fake-webhook-secret-for-tests'

let app: FastifyInstance
let fake: FakeGitLab
let jobs: InlineJobQueue
let failures: string[]
let admin: Who
let pm: Who
let dev: Who
let outsider: Who
let nurse: Who
let projectId: string
let repoA: Repo
let uuidSeq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })
const approve = { text: '', decision: 'approve' }

const ORIGINAL = 'ผลแล็บไม่แสดงในหน้ารายงาน\n\nขั้นตอน: เปิดหน้ารายงาน <!-- yoda:end --> แล้วกดค้นหา'

async function setup(connected = true) {
  fake = await startFakeGitLab()
  fake.addProject('dept/lab-report', 11)
  fake.addProject('dept/lab-web', 12)
  failures = []
  // This file opts in to gitlab-issue-sync and gitlab-mr-effect (the default test queue drops both).
  jobs = new InlineJobQueue({
    onError: (err, name, id) => {
      failures.push(`${name} ${id}`)
      console.warn(err)
    },
    ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief'],
  })
  app = await makeApp({ jobs, gitlab: connected ? new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }) : null })
  app.deps.config.gitlabWebhookSecret = SECRET
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  outsider = await login(app, 'outsider', { staff: true })
  nurse = await login(app, 'nurse', { name: 'สมใจ ใจดีมาก' })
  projectId = ((await call(admin, 'POST', '/projects', { name: 'ระบบแล็บ' })).json() as { id: string }).id
  await call(admin, 'PUT', `/projects/${projectId}/members/${pm.id}`, { roles: ['PM'] })
  await call(admin, 'PUT', `/projects/${projectId}/members/${dev.id}`, { roles: ['DEV', 'QC'] })
  if (connected) {
    repoA = (await call(pm, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-report' })).json() as Repo
    expect((await call(pm, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-web' })).statusCode).toBe(201)
  }
}

const importIssue = (who: Who, body: Record<string, unknown>, project = projectId) => call(who, 'POST', `/projects/${project}/import-issue`, body)
const detail = async (id: string) => (await call(pm, 'GET', `/work-items/${id}`)).json() as WorkItemDetail
const latest = async (id: string, key: string): Promise<Task> => (await detail(id)).tasks.filter((t) => t.templateTaskKey === key).at(-1)!
const code = async (id: string) => (await call(pm, 'GET', `/work-items/${id}/code`)).json() as WorkItemCode
const issue = (gitlabProjectId: number, iid: number) => fake.issues.get(gitlabProjectId)!.find((i) => i.iid === iid)!

async function submit(id: string, key: string, who: Who, result: Record<string, unknown> = { text: 'ok' }) {
  const t = await latest(id, key)
  if (t.assigneeId !== who.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  const res = await call(who, 'POST', `/tasks/${t.id}/submit`, result)
  expect(res.statusCode).toBe(200)
}

async function hook(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/gitlab/webhook',
    headers: { 'content-type': 'application/json', 'x-gitlab-token': SECRET, 'x-gitlab-event-uuid': `fake-uuid-${++uuidSeq}` },
    payload: JSON.stringify({ project: { id: 11, path_with_namespace: 'dept/lab-report' }, user: { id: 7, username: 'somchai.dev' }, ...payload }),
  })
  expect(res.statusCode).toBe(200)
  await jobs.drain()
}
const mrHook = (workItemId: string, state: string) =>
  hook({
    object_kind: 'merge_request',
    object_attributes: {
      iid: 5,
      title: 'Fix lab report',
      url: `${fake.url}/dept/lab-report/-/merge_requests/5`,
      state,
      source_branch: `yoda/${workItemId.slice(0, 8)}-fix`,
      description: '',
    },
  })

beforeEach(async () => {
  await resetDb(await testDb())
})
afterEach(async () => {
  await jobs?.drain()
  await app?.close()
  await fake?.stop()
  expect(failures).toEqual([])
})

describe('import a gitlab issue', () => {
  beforeEach(() => setup())

  it('creates a bug-fix item linked to the issue; the next sync keeps the original body above the section', async () => {
    const seeded = fake.seedIssue(11, { title: '  รายงานแล็บว่าง  ', description: ORIGINAL })
    const res = await importIssue(dev, { repoId: repoA.id, issueIid: seeded.iid })
    expect(res.statusCode).toBe(201)
    const item = res.json() as WorkItemDetail
    expect(item.templateKey).toBe('bug-fix')
    expect(item.title).toBe('รายงานแล็บว่าง')
    expect(item.ownerId).toBe(dev.id)
    expect(item.requesterId).toBeNull()
    // Prefixed with the issue URL; untrusted HTML comment markers are neutralized.
    expect(item.description.startsWith(`${seeded.web_url}\n\n`)).toBe(true)
    expect(item.description).toContain('ผลแล็บไม่แสดงในหน้ารายงาน')
    expect(item.description).not.toContain('<!--')
    expect(item.description).not.toContain('-->')

    // Only the imported repo is linked, with the issue already known.
    const links = await app.deps.db.select().from(workItemRepos).where(eq(workItemRepos.workItemId, item.id))
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ repoId: repoA.id, issueIid: seeded.iid, issueUrl: seeded.web_url })

    await jobs.drain()
    // No new issue was created; the original body stays above the portal's section.
    expect(fake.issues.get(11)).toHaveLength(1)
    expect(fake.issues.get(12)).toHaveLength(0)
    const body = issue(11, seeded.iid).description
    expect(body.startsWith(ORIGINAL)).toBe(true)
    expect(body.indexOf(ISSUE_BEGIN)).toBeGreaterThan(ORIGINAL.length - 1)
    expect(body.trimEnd().endsWith(ISSUE_END)).toBe(true)
    // The original body is already above the section: no "original request" copy of it inside.
    expect(body).not.toContain(HEADINGS.originalRequest)
    expect(body.split('ผลแล็บไม่แสดงในหน้ารายงาน')).toHaveLength(2)
    // The first push of an imported issue adds no "updated from the portal" comment.
    expect(fake.notes.get(`11/${seeded.iid}`) ?? []).toEqual([])
    const c = await code(item.id)
    expect(c.issues).toMatchObject([{ repoId: repoA.id, issueIid: seeded.iid, status: 'synced' }])
    const types = (await app.deps.db.select({ type: events.type }).from(events).where(eq(events.workItemId, item.id))).map((e) => e.type)
    expect(types).toContain('work_item.created')
    expect(types).toContain('gitlab.issue_synced')

    // Dev starts: the issue is adopted, never duplicated.
    await submit(item.id, 'accept-bug', pm, approve)
    await acceptStepAdvance(app, pm, item.id)
    await jobs.drain()
    expect((await detail(item.id)).currentStepKey).toBe('dev')
    expect(fake.issues.get(11)).toHaveLength(1)
    expect(issue(11, seeded.iid).description.startsWith(ORIGINAL)).toBe(true)
  })

  it('importing an issue that is already linked → 409', async () => {
    const seeded = fake.seedIssue(11, { title: 'ซ้ำ', description: '' })
    expect((await importIssue(dev, { repoId: repoA.id, issueIid: seeded.iid })).statusCode).toBe(201)
    const again = await importIssue(pm, { repoId: repoA.id, issueIid: seeded.iid })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'invalid_state' })
    // Concurrent imports of the same issue: exactly one wins.
    const other = fake.seedIssue(11, { title: 'พร้อมกัน', description: '' })
    const both = await Promise.all([importIssue(dev, { repoId: repoA.id, issueIid: other.iid }), importIssue(pm, { repoId: repoA.id, issueIid: other.iid })])
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409])
  })

  it('honors templateKey; an empty title falls back to the issue number; long text is clipped', async () => {
    const seeded = fake.seedIssue(11, { title: '   ', description: 'x'.repeat(20_000) })
    const res = await importIssue(dev, { repoId: repoA.id, issueIid: seeded.iid, templateKey: 'software-change' })
    expect(res.statusCode).toBe(201)
    const item = res.json() as WorkItemDetail
    expect(item.templateKey).toBe('software-change')
    expect(item.title).toBe(`dept/lab-report#${seeded.iid}`)
    expect(item.description.length).toBeLessThanOrEqual(10_000)
    const fresh = fake.seedIssue(11, { title: 'อีกเรื่อง', description: '' })
    expect((await importIssue(dev, { repoId: repoA.id, issueIid: fresh.iid, templateKey: 'no-such-template' })).statusCode).toBe(404)
  })

  it('refuses requesters (403), non-members (404), foreign repos and unknown issues (422); GitLab down → 502', async () => {
    const seeded = fake.seedIssue(11, { title: 'บั๊ก', description: '' })
    expect((await importIssue(nurse, { repoId: repoA.id, issueIid: seeded.iid })).statusCode).toBe(403)
    expect((await importIssue(outsider, { repoId: repoA.id, issueIid: seeded.iid })).statusCode).toBe(404)
    expect((await importIssue(dev, { repoId: repoA.id, issueIid: 0 })).statusCode).toBe(400)

    const otherProject = ((await call(admin, 'POST', '/projects', { name: 'อีกโครงการ' })).json() as { id: string }).id
    await call(admin, 'PUT', `/projects/${otherProject}/members/${dev.id}`, { roles: ['DEV'] })
    const foreign = await importIssue(dev, { repoId: repoA.id, issueIid: seeded.iid }, otherProject)
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json()).toEqual({ error: 'repo_not_found' })

    const missing = await importIssue(dev, { repoId: repoA.id, issueIid: 999 })
    expect(missing.statusCode).toBe(422)
    expect(missing.json()).toEqual({ error: 'issue_not_found' })

    fake.failNext(500, 3)
    const down = await importIssue(dev, { repoId: repoA.id, issueIid: seeded.iid })
    expect(down.statusCode).toBe(502)
    expect(down.json()).toEqual({ error: 'gitlab_unavailable' })
    expect(down.body).not.toContain('fake-test-token')
    expect((await app.deps.db.select().from(workItemRepos).where(eq(workItemRepos.issueIid, seeded.iid)))).toHaveLength(0)
  })
})

describe('import without GitLab', () => {
  beforeEach(() => setup(false))

  it('answers gitlab_not_connected', async () => {
    const res = await importIssue(dev, { repoId: '00000000-0000-4000-8000-000000000000', issueIid: 1 })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'gitlab_not_connected' })
  })
})

describe('requester probing', () => {
  beforeEach(() => setup())

  it('task, request, notification and stream responses for the requester carry no GitLab data', async () => {
    const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
      title: 'แก้รายงานแล็บ',
      description: 'ผลแล็บไม่แสดง',
      templateKey: 'bug-fix',
      requesterId: nurse.id,
    })
    expect(res.statusCode).toBe(201)
    const id = (res.json() as { id: string }).id
    expect((await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [repoA.id] })).statusCode).toBe(200)
    await submit(id, 'accept-bug', pm, approve)
    await acceptStepAdvance(app, pm, id)
    await jobs.drain()
    expect(fake.issues.get(11)).toHaveLength(1)

    await mrHook(id, 'opened')
    await hook({ object_kind: 'pipeline', object_attributes: { id: 77, status: 'failed', ref: 'x' }, merge_request: { iid: 5 } })
    await hook({ object_kind: 'note', object_attributes: { id: 9, note: 'ต้องเพิ่ม index ที่ตาราง lab_results', noteable_type: 'Issue' }, issue: { iid: 1 } })
    await submit(id, 'draft-tests', dev, { text: 'กรณีทดสอบ' })
    await mrHook(id, 'merged')
    expect((await latest(id, 'review-code')).state).toBe('accepted')
    await acceptStepAdvance(app, pm, id)
    await submit(id, 'verify', dev, { text: 'ผ่าน' })
    await submit(id, 'approve-release', dev, approve)
    await acceptStepAdvance(app, pm, id)
    await jobs.drain()
    const delivery = await latest(id, 'accept-delivery')
    expect(delivery.assigneeId).toBe(nurse.id)

    // Staff see the GitLab trail on the item.
    const staffJson = JSON.stringify(await detail(id))
    expect(staffJson).toContain('gitlab.mr_merged')
    expect(staffJson).toContain(fake.url)

    const probe = (body: string) => {
      expect(body).not.toContain(fake.url)
      expect(body).not.toContain('127.0.0.1')
      expect(body.toLowerCase()).not.toContain('gitlab')
      expect(body).not.toContain('merge_request')
      expect(body).not.toContain('merged_in_gitlab')
      expect(body).not.toContain('lab_results')
    }
    const answers = await call(nurse, 'GET', '/me/answers')
    expect(answers.statusCode).toBe(200)
    expect((answers.json() as TaskWithContext[]).map((t) => t.id)).toEqual([delivery.id])
    probe(answers.body)
    const task = await call(nurse, 'GET', `/tasks/${delivery.id}`)
    expect(task.statusCode).toBe(200)
    expect((task.json() as TaskWithContext).inputs).toEqual([])
    probe(task.body)
    const requests = await call(nurse, 'GET', '/me/requests')
    expect(requests.statusCode).toBe(200)
    probe(requests.body)
    const notes = await call(nurse, 'GET', '/me/notifications')
    expect(notes.statusCode).toBe(200)
    probe(notes.body)

    // Staff-only endpoints stay closed.
    expect((await call(nurse, 'GET', `/work-items/${id}`)).statusCode).toBe(404)
    expect((await call(nurse, 'GET', `/work-items/${id}/code`)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/projects/${projectId}/repos`)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/knowledge?workItemId=${id}`)).statusCode).toBe(403)

    // Live events about GitLab activity never reach the requester's stream.
    const me = (await personAsMe(app.deps.db, nurse.id))!
    const gitlabEvents = (await app.deps.db.select().from(events).where(eq(events.workItemId, id))).filter((e) => e.type.startsWith('gitlab.'))
    expect(gitlabEvents.map((e) => e.type).sort()).toEqual(expect.arrayContaining(['gitlab.issue_synced', 'gitlab.mr_opened', 'gitlab.mr_merged', 'gitlab.pipeline', 'gitlab.note']))
    for (const e of gitlabEvents) {
      const live: LiveEvent = { type: e.type as LiveEvent['type'], projectId: e.projectId, workItemId: e.workItemId, taskId: e.taskId, conversationId: null, personId: null }
      expect(await deliverable(app.deps.db, me, live)).toBe(false)
    }
  })
})
