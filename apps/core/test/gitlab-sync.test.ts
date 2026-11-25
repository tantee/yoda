import type { FastifyInstance } from 'fastify'
import type { Repo, Task, WorkItemCode, WorkItemDetail } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { events } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { ISSUE_BEGIN, workItemMarker } from '../src/gitlab/issue-section.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let fake: FakeGitLab
let jobs: InlineJobQueue
let admin: Who
let pm: Who
let dev: Who
let nurse: Who
let projectId: string
let repoA: Repo
let repoB: Repo
let failures: string[]

const REQUESTER_NAME = 'สมใจ ใจดีมาก'
const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })
const approve = { text: '', decision: 'approve' }

async function setup(connected = true) {
  fake = await startFakeGitLab()
  fake.addProject('dept/lab-report', 11)
  fake.addProject('dept/lab-web', 12)
  failures = []
  // This file opts in to gitlab-issue-sync (the default test queue drops it).
  jobs = new InlineJobQueue({
    onError: (_err, name, id) => failures.push(`${name} ${id}`),
    ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief'],
  })
  app = await makeApp({ jobs, gitlab: connected ? new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }) : null })
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  nurse = await login(app, 'nurse', { name: REQUESTER_NAME })
  projectId = ((await call(admin, 'POST', '/projects', { name: 'ระบบแล็บ' })).json() as { id: string }).id
  await call(admin, 'PUT', `/projects/${projectId}/members/${pm.id}`, { roles: ['PM'] })
  await call(admin, 'PUT', `/projects/${projectId}/members/${dev.id}`, { roles: ['DEV', 'QC'] })
  if (connected) {
    repoA = (await call(pm, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-report' })).json() as Repo
    repoB = (await call(pm, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-web' })).json() as Repo
  }
}

const newItem = async (): Promise<string> => {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, {
    title: 'แก้รายงานแล็บ',
    description: `ผลแล็บไม่แสดง (แจ้งโดย ${'ผู้ใช้'})`,
    templateKey: 'bug-fix',
    requesterId: nurse.id,
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

const detail = async (id: string) => (await call(pm, 'GET', `/work-items/${id}`)).json() as WorkItemDetail
const active = async (id: string, key: string): Promise<Task> => (await detail(id)).tasks.filter((t) => t.templateTaskKey === key).at(-1)!

async function drive(itemId: string, key: string, who: Who, result: Record<string, unknown> = { text: 'ok' }) {
  const t = await active(itemId, key)
  if (t.assigneeId !== who.id) expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: who.id })).statusCode).toBe(200)
  const res = await call(who, 'POST', `/tasks/${t.id}/submit`, result)
  expect(res.statusCode).toBe(200)
  await acceptStepAdvance(app, pm, itemId)
}

/** Work item in the Dev step (its code-change task exists), with the first sync finished. */
async function itemInDev(): Promise<string> {
  const id = await newItem()
  await drive(id, 'accept-bug', pm, approve)
  await jobs.drain()
  return id
}

const code = async (id: string) => (await call(pm, 'GET', `/work-items/${id}/code`)).json() as WorkItemCode
const issue = (projectId: number, iid: number) => fake.issues.get(projectId)!.find((i) => i.iid === iid)!
const count = (method: string, re: RegExp) => fake.requests.filter((r) => r.method === method && re.test(r.path)).length
const typesOf = async (workItemId: string) =>
  (await app.deps.db.select({ type: events.type, payload: events.payload }).from(events).where(eq(events.workItemId, workItemId)))
const resync = async (id: string) => {
  await jobs.send('gitlab-issue-sync', { id })
  await jobs.drain()
}

beforeEach(async () => {
  await resetDb(await testDb())
})
afterEach(async () => {
  await jobs?.drain()
  await app?.close()
  await fake?.stop()
})

describe('gitlab issue sync', () => {
  beforeEach(() => setup())

  it('creates one issue per repo when Dev starts, with cross-links and no requester names', async () => {
    const id = await newItem()
    await jobs.drain()
    expect(count('POST', /\/issues$/)).toBe(0)

    await drive(id, 'accept-bug', pm, approve)
    await jobs.drain()
    expect(failures).toEqual([])
    expect(count('POST', /\/issues$/)).toBe(2)
    const c = await code(id)
    expect(c.issues.map((i) => i.status)).toEqual(['synced', 'synced'])
    const a = c.issues.find((i) => i.repoId === repoA.id)!
    const b = c.issues.find((i) => i.repoId === repoB.id)!
    expect(a.issueIid).toBe(1)
    expect(a.issueUrl).toBe(`${fake.url}/dept/lab-report/-/issues/1`)
    const bodyA = issue(11, a.issueIid!).description
    const bodyB = issue(12, b.issueIid!).description
    expect(issue(11, 1).title).toBe('แก้รายงานแล็บ')
    expect(bodyA).toContain(workItemMarker(id))
    expect(bodyA).toContain(`http://localhost:3000/work-items/${id}`)
    expect(bodyA).toContain('`Closes #1`')
    // Sibling cross-links are filled once both issues exist.
    expect(bodyA).toContain(`[dept/lab-web#${b.issueIid}](${b.issueUrl})`)
    expect(bodyB).toContain(`[dept/lab-report#${a.issueIid}](${a.issueUrl})`)
    for (const body of [bodyA, bodyB]) {
      expect(body).not.toContain(REQUESTER_NAME)
      expect(body).not.toContain('nurse')
    }
    // No note on creation.
    expect(fake.notes.size).toBe(0)
    const ev = await typesOf(id)
    expect(ev.filter((e) => e.type === 'gitlab.issue_synced')).toHaveLength(2)
  })

  it('re-sync without a content change makes no update and no note', async () => {
    const id = await itemInDev()
    const puts = count('PUT', /\/issues\/\d+$/)
    await resync(id)
    await resync(id)
    expect(count('PUT', /\/issues\/\d+$/)).toBe(puts)
    expect(count('POST', /\/issues$/)).toBe(2)
    expect(fake.notes.size).toBe(0)
  })

  it('a decision decided later updates each issue and adds one note', async () => {
    const id = await itemInDev()
    const puts = count('PUT', /\/issues\/\d+$/)
    const d = await call(pm, 'POST', '/discussions', { workItemId: id, question: 'ใช้ตารางผลแล็บเดิมไหม', requestBrief: false })
    expect(d.statusCode).toBe(201)
    await jobs.drain()
    expect(count('PUT', /\/issues\/\d+$/)).toBe(puts)
    const dec = await call(pm, 'POST', `/discussions/${(d.json() as { id: string }).id}/decide`, { decision: 'ใช้ตารางเดิม เพิ่มคอลัมน์' })
    expect(dec.statusCode).toBe(200)
    await jobs.drain()
    expect(failures).toEqual([])
    expect(count('PUT', /\/issues\/\d+$/)).toBe(puts + 2)
    expect(issue(11, 1).description).toContain('ใช้ตารางผลแล็บเดิมไหม')
    expect(issue(11, 1).description).toContain('ใช้ตารางเดิม เพิ่มคอลัมน์')
    expect(fake.notes.get('11/1')).toHaveLength(1)
    expect(fake.notes.get('12/1')).toHaveLength(1)
    expect(fake.notes.get('11/1')![0]).toContain('การตัดสินใจ / Decisions')
    // The decision appears once (the discussion, not also its knowledge entry).
    expect(issue(11, 1).description.split('ใช้ตารางผลแล็บเดิมไหม')).toHaveLength(2)
  })

  it('requested changes on the code show up in the issue', async () => {
    const id = await itemInDev()
    await drive(id, 'implement', dev)
    await drive(id, 'review-code', dev, { text: 'ปุ่มพิมพ์ยังไม่ทำงาน', decision: 'changes' })
    await jobs.drain()
    expect(issue(11, 1).description).toContain('Changes requested')
    expect(issue(11, 1).description).toContain('ปุ่มพิมพ์ยังไม่ทำงาน')
    expect(fake.notes.get('11/1')).toHaveLength(1)
  })

  it('accepted test cases from the Dev step show up in the issue', async () => {
    const id = await itemInDev()
    await drive(id, 'draft-tests', dev, { text: 'กรณีทดสอบ: เปิดรายงานย้อนหลัง 30 วัน' })
    await jobs.drain()
    expect(issue(11, 1).description).toContain('กรณีทดสอบ: เปิดรายงานย้อนหลัง 30 วัน')
    expect(fake.notes.get('11/1')![0]).toContain('กรณีทดสอบ / Test cases')
  })

  it('keeps a developer’s text and re-appends the section when the markers were deleted', async () => {
    const id = await itemInDev()
    issue(11, 1).description = 'บันทึกของนักพัฒนา: ใช้ API ใหม่'
    await resync(id)
    const body = issue(11, 1).description
    expect(body.startsWith('บันทึกของนักพัฒนา: ใช้ API ใหม่\n\n')).toBe(true)
    expect(body).toContain(ISSUE_BEGIN)
    // A content change later replaces only the owned section.
    const k = await call(pm, 'POST', '/knowledge', { scope: 'work_item', workItemId: id, type: 'decision', title: 'ใช้ API v2', body: 'ตกลงใช้ API v2' })
    expect(k.statusCode).toBe(201)
    await jobs.drain()
    const after = issue(11, 1).description
    expect(after.startsWith('บันทึกของนักพัฒนา: ใช้ API ใหม่\n\n')).toBe(true)
    expect(after).toContain('ตกลงใช้ API v2')
    expect(after.split(ISSUE_BEGIN)).toHaveLength(2)
  })

  it('adopts an existing issue carrying the work item marker instead of creating a duplicate', async () => {
    const id = await newItem()
    const seeded = fake.seedIssue(11, { title: 'แก้รายงานแล็บ', description: `old\n${workItemMarker(id)}` })
    await drive(id, 'accept-bug', pm, approve)
    await jobs.drain()
    expect(fake.issues.get(11)).toHaveLength(1)
    const a = (await code(id)).issues.find((i) => i.repoId === repoA.id)!
    expect(a.issueIid).toBe(seeded.iid)
    expect(count('POST', /\/projects\/11\/issues$/)).toBe(0)
  })

  it('GitLab down for every attempt: sync fails, the work item still advances', async () => {
    const id = await newItem()
    fake.failNext(500, 10_000)
    await drive(id, 'accept-bug', pm, approve)
    await jobs.drain()
    const c = await code(id)
    expect(c.issues.map((i) => [i.status, i.error])).toEqual([['failed', 'unavailable'], ['failed', 'unavailable']])
    const ev = await typesOf(id)
    expect(ev.filter((e) => e.type === 'gitlab.issue_sync_failed')).toHaveLength(2)
    expect(JSON.stringify(ev)).not.toContain('fake-test-token')
    expect(failures).toEqual([`gitlab-issue-sync ${id}`])
    fake.failNext(500, 0)
    await drive(id, 'implement', dev)
    expect((await active(id, 'implement')).state).toBe('accepted')
  })

  it('an issue deleted in GitLab is marked missing and not recreated', async () => {
    const id = await itemInDev()
    fake.issues.set(11, [])
    await resync(id)
    const a = (await code(id)).issues.find((i) => i.repoId === repoA.id)!
    expect([a.status, a.error, a.issueIid]).toEqual(['failed', 'issue_missing', 1])
    expect(count('POST', /\/projects\/11\/issues$/)).toBe(1)
    const failed = (await typesOf(id)).filter((e) => e.type === 'gitlab.issue_sync_failed')
    expect(failed).toHaveLength(1)
  })
})

describe('gitlab issue sync without GitLab configured', () => {
  beforeEach(() => setup(false))

  it('does nothing and leaves the items pending', async () => {
    const { projectRepos } = await import('../src/db/schema.js')
    await app.deps.db.insert(projectRepos).values({ projectId, gitlabProjectId: 11, pathWithNamespace: 'dept/lab-report', webUrl: 'http://gl.test/dept/lab-report', defaultBranch: 'main' })
    const id = await itemInDev()
    expect(fake.requests).toEqual([])
    expect((await code(id)).issues.map((i) => [i.status, i.issueIid])).toEqual([['pending', null]])
    const rows = await app.deps.db.select().from(events).where(and(eq(events.workItemId, id), eq(events.type, 'gitlab.issue_synced')))
    expect(rows).toEqual([])
  })
})
