import type { FastifyInstance } from 'fastify'
import type { Repo, Task, WorkItemDetail } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { events, gitlabDeliveries, gitlabSettings, knowledgeEntries, mergeRequests, notifications } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { closingRefs, sanitizeNote } from '../src/gitlab/webhook.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import type { JobName } from '../src/jobs/queue.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { acceptStepAdvance, auth, login, makeApp, type Who } from './support.js'

// Obviously fake test value; never a real secret.
const SECRET = 'fake-webhook-secret-for-tests'
const BOT_ID = 1 // FakeGitLab's /user

let app: FastifyInstance
let fake: FakeGitLab
let jobs: InlineJobQueue
let sent: { name: JobName; id: string }[]
let admin: Who
let pm: Who
let dev: Who
let projectId: string
let repo: Repo
let uuidSeq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

const hook = (payload: unknown, opts: { token?: string | null; uuid?: string; event?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gitlab-event-uuid': opts.uuid ?? `fake-uuid-${++uuidSeq}` }
  if (opts.token !== null) headers['x-gitlab-token'] = opts.token ?? SECRET
  return app.inject({ method: 'POST', url: '/gitlab/webhook', headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) })
}

const mr = (o: { project?: number; iid?: number; state?: string; description?: string; branch?: string; title?: string }) => ({
  object_kind: 'merge_request',
  project: { id: o.project ?? 11, path_with_namespace: 'dept/lab-report' },
  user: { id: 7, username: 'somchai.dev' },
  object_attributes: {
    iid: o.iid ?? 5,
    title: o.title ?? 'Fix lab report',
    url: `http://gitlab.example.test/dept/lab-report/-/merge_requests/${o.iid ?? 5}`,
    state: o.state ?? 'opened',
    action: 'open',
    source_branch: o.branch ?? 'fix-lab',
    description: o.description ?? '',
  },
})

const pipeline = (o: { id: number; status: string; mrIid?: number | null; ref?: string }) => ({
  object_kind: 'pipeline',
  project: { id: 11 },
  object_attributes: { id: o.id, status: o.status, ref: o.ref ?? 'fix-lab' },
  merge_request: o.mrIid === null ? null : { iid: o.mrIid ?? 5 },
})

const note = (o: { iid: number; userId: number; username: string; text: string; id?: number }) => ({
  object_kind: 'note',
  project: { id: 11 },
  user: { id: o.userId, username: o.username },
  object_attributes: { id: o.id ?? 900, note: o.text, noteable_type: 'Issue', system: false },
  issue: { iid: o.iid },
})

async function setup(opts: { secret?: boolean } = {}) {
  fake = await startFakeGitLab()
  fake.addProject('dept/lab-report', 11)
  // Issues the portal didn't create take iids 1..11, so the portal's issue is #12.
  for (let i = 0; i < 11; i++) fake.seedIssue(11, { title: `existing ${i}`, description: 'not from the portal' })
  sent = []
  // Opts in to gitlab-issue-sync (to create the issue) and records gitlab-mr-effect sends.
  jobs = new InlineJobQueue({ ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief'] })
  const send = jobs.send.bind(jobs)
  jobs.send = async (name, data) => {
    sent.push({ name, id: data.id })
    return send(name, data)
  }
  app = await makeApp({ jobs, gitlab: new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }) })
  if (opts.secret !== false) app.deps.config.gitlabWebhookSecret = SECRET
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  projectId = ((await call(admin, 'POST', '/projects', { name: 'ระบบแล็บ' })).json() as { id: string }).id
  await call(admin, 'PUT', `/projects/${projectId}/members/${pm.id}`, { roles: ['PM'] })
  await call(admin, 'PUT', `/projects/${projectId}/members/${dev.id}`, { roles: ['DEV', 'QC'] })
  repo = (await call(pm, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-report' })).json() as Repo
}

const detail = async (id: string) => (await call(pm, 'GET', `/work-items/${id}`)).json() as WorkItemDetail
const active = async (id: string, key: string): Promise<Task> => (await detail(id)).tasks.filter((t) => t.templateTaskKey === key).at(-1)!

/** A bug-fix work item in the Dev step with its GitLab issue (#12) created. */
async function itemInDev(): Promise<string> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'แก้รายงานแล็บ', description: 'ผลแล็บไม่แสดง', templateKey: 'bug-fix' })
  expect(res.statusCode).toBe(201)
  const id = (res.json() as { id: string }).id
  const t = await active(id, 'accept-bug')
  expect((await call(pm, 'POST', `/tasks/${t.id}/assign`, { personId: pm.id })).statusCode).toBe(200)
  expect((await call(pm, 'POST', `/tasks/${t.id}/submit`, { text: '', decision: 'approve' })).statusCode).toBe(200)
  await acceptStepAdvance(app, pm, id)
  await jobs.drain()
  expect(fake.issues.get(11)!.some((i) => i.iid === 12 && i.description.includes(id))).toBe(true)
  return id
}

const eventsOf = async (type: string) => app.deps.db.select().from(events).where(eq(events.type, type))
const mrRows = () => app.deps.db.select().from(mergeRequests)
const effects = () => sent.filter((j) => j.name === 'gitlab-mr-effect')

beforeEach(async () => {
  await resetDb(await testDb())
})
afterEach(async () => {
  await jobs?.drain()
  await app?.close()
  await fake?.stop()
})

describe('closingRefs', () => {
  it('reads closing keywords for this project only', () => {
    expect(closingRefs('Closes #12', 'dept/lab-report')).toEqual([12])
    expect(closingRefs('fixes #3, #4 and #5\nresolves dept/lab-report#9', 'dept/lab-report')).toEqual([3, 4, 5, 9])
    expect(closingRefs('Resolves other/repo#9 and closes DEPT/Lab-Report#2', 'dept/lab-report')).toEqual([2])
    expect(closingRefs('see #12, related to #4', 'dept/lab-report')).toEqual([])
  })
  it('strips HTML comment markers from notes', () => {
    expect(sanitizeNote('a <!-- yoda:begin --> b <!<!---->-- c -->')).not.toMatch(/<!--|-->/)
  })
})

describe('gitlab webhook', () => {
  it('rejects when the secret is not configured', async () => {
    await setup({ secret: false })
    const res = await hook(mr({}), { token: 'anything' })
    expect(res.statusCode).toBe(401)
    expect(await app.deps.db.select().from(gitlabDeliveries)).toHaveLength(0)
  })

  describe('configured', () => {
    beforeEach(() => setup())

    it('rejects a wrong or missing token and stores nothing', async () => {
      await itemInDev()
      for (const token of ['wrong', `${SECRET}x`, '', null]) {
        const res = await hook(mr({ description: 'Closes #12' }), { token })
        expect(res.statusCode).toBe(401)
        expect(res.body).not.toContain(SECRET)
      }
      expect(await app.deps.db.select().from(gitlabDeliveries)).toHaveLength(0)
      expect(await mrRows()).toHaveLength(0)
      const [s] = await app.deps.db.select().from(gitlabSettings)
      expect(s!.lastWebhookAt).toBeNull()
    })

    it('rejects malformed JSON with 400', async () => {
      const res = await hook('{not json', {})
      expect(res.statusCode).toBe(400)
      expect(await app.deps.db.select().from(gitlabDeliveries)).toHaveLength(0)
    })

    it('rejects a body over 1 MB', async () => {
      const res = await hook({ object_kind: 'push', pad: 'x'.repeat(1_100_000) })
      expect(res.statusCode).toBe(413)
    })

    it('links an opened MR that closes the portal issue, once per delivery', async () => {
      const id = await itemInDev()
      const res = await hook(mr({ description: 'Closes #12' }), { uuid: 'fake-uuid-replay' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
      const [row] = await mrRows()
      expect(row).toMatchObject({ repoId: repo.id, mrIid: 5, workItemId: id, state: 'opened', sourceBranch: 'fix-lab', title: 'Fix lab report' })
      expect(await eventsOf('gitlab.mr_opened')).toHaveLength(1)
      expect(effects()).toEqual([{ name: 'gitlab-mr-effect', id: row!.id }])
      const [s] = await app.deps.db.select().from(gitlabSettings)
      expect(s!.lastWebhookAt).not.toBeNull()

      const again = await hook(mr({ description: 'Closes #12' }), { uuid: 'fake-uuid-replay' })
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual({ ok: true, duplicate: true })
      expect(await eventsOf('gitlab.mr_opened')).toHaveLength(1)
      expect(effects()).toHaveLength(1)

      // A new delivery with the same state records nothing new; the merge records one event.
      await hook(mr({ description: 'Closes #12' }))
      expect(await eventsOf('gitlab.mr_opened')).toHaveLength(1)
      expect(effects()).toHaveLength(1)
      await hook(mr({ description: 'Closes #12', state: 'merged' }))
      await hook(mr({ description: 'Closes #12', state: 'merged' }))
      expect(await eventsOf('gitlab.mr_merged')).toHaveLength(1)
      expect(effects()).toHaveLength(2)
      // A late "opened" delivery never un-merges.
      await hook(mr({ description: 'Closes #12', state: 'opened' }))
      expect((await mrRows())[0]!.state).toBe('merged')
    })

    it('links by the yoda/<shortId>- branch prefix', async () => {
      const id = await itemInDev()
      await hook(mr({ branch: `yoda/${id.slice(0, 8)}-fix-report` }))
      const [row] = await mrRows()
      expect(row!.workItemId).toBe(id)
      expect(await eventsOf('gitlab.mr_opened')).toHaveLength(1)
    })

    it('ignores an MR in a GitLab project no portal project links', async () => {
      await itemInDev()
      const res = await hook(mr({ project: 99, description: 'Closes #12' }))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, ignored: true })
      expect(await mrRows()).toHaveLength(0)
      expect(effects()).toHaveLength(0)
    })

    it('stores an MR closing an issue the portal did not create unlinked, with no workflow job', async () => {
      await itemInDev()
      const res = await hook(mr({ description: 'Closes #3', branch: 'yoda/deadbeef-x' }))
      expect(res.statusCode).toBe(200)
      const [row] = await mrRows()
      expect(row!.workItemId).toBeNull()
      expect(await eventsOf('gitlab.mr_opened')).toHaveLength(0)
      expect(effects()).toHaveLength(0)
    })

    it('notifies the implement assignee once per failed pipeline', async () => {
      const id = await itemInDev()
      const impl = await active(id, 'implement')
      expect((await call(pm, 'POST', `/tasks/${impl.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
      await hook(mr({ description: 'Closes #12' }))
      await hook(pipeline({ id: 301, status: 'running' }))
      expect((await mrRows())[0]!.pipeline).toBe('running')
      await hook(pipeline({ id: 301, status: 'failed' }))
      await hook(pipeline({ id: 301, status: 'failed' }))
      expect((await mrRows())[0]!.pipeline).toBe('failed')
      const mine = await app.deps.db.select().from(notifications).where(eq(notifications.personId, dev.id))
      const failedNote = mine.filter((n) => n.dedupeKey?.startsWith('pipeline:'))
      expect(failedNote).toHaveLength(1)
      expect(failedNote[0]!.dedupeKey).toBe(`pipeline:${(await mrRows())[0]!.id}:301`)
      expect(await eventsOf('gitlab.pipeline')).toHaveLength(1)
      // A later pipeline (no MR in the payload, matched by branch) that fails notifies again.
      await hook(pipeline({ id: 302, status: 'failed', mrIid: null }))
      const after = await app.deps.db.select().from(notifications).where(eq(notifications.personId, dev.id))
      expect(after.filter((n) => n.dedupeKey?.startsWith('pipeline:'))).toHaveLength(2)
    })

    it('records a developer note on the portal issue as an event and a draft knowledge entry', async () => {
      const id = await itemInDev()
      const text = `ตรวจแล้ว <!-- yoda:end --> ต้องแก้ query ${'ก'.repeat(700)}`
      const res = await hook(note({ iid: 12, userId: 7, username: 'somchai.dev', text }))
      expect(res.statusCode).toBe(200)
      const [ev] = await eventsOf('gitlab.note')
      expect(ev!.workItemId).toBe(id)
      const payload = ev!.payload as { author: string; excerpt: string }
      expect(payload.author).toBe('somchai.dev')
      expect(payload.excerpt.length).toBeLessThanOrEqual(500)
      expect(payload.excerpt).not.toContain('-->')
      const entries = await app.deps.db.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.workItemId, id), eq(knowledgeEntries.sourceKind, 'gitlab')))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ type: 'progress', status: 'draft', scope: 'work_item' })
      expect(entries[0]!.body).not.toMatch(/<!--|-->/)
      expect(entries[0]!.body).toContain('ต้องแก้ query')
      // Redelivered with a new UUID: still one entry.
      await hook(note({ iid: 12, userId: 7, username: 'somchai.dev', text }))
      expect(await app.deps.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.sourceKind, 'gitlab'))).toHaveLength(1)
      expect(await eventsOf('gitlab.note')).toHaveLength(1)
    })

    it('ignores notes by the bot and notes on issues the portal did not create', async () => {
      await itemInDev()
      const bot = await hook(note({ iid: 12, userId: BOT_ID, username: 'yoda-bot', text: 'ปรับปรุงจากพอร์ทัล', id: 901 }))
      expect(bot.json()).toEqual({ ok: true, ignored: true })
      const other = await hook(note({ iid: 3, userId: 7, username: 'somchai.dev', text: 'hello', id: 902 }))
      expect(other.json()).toEqual({ ok: true, ignored: true })
      expect(await eventsOf('gitlab.note')).toHaveLength(0)
      expect(await app.deps.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.sourceKind, 'gitlab'))).toHaveLength(0)
    })

    it('answers 503 without marking the delivery seen when the bot user cannot be resolved', async () => {
      const id = await itemInDev()
      fake.failNext(500, 3)
      const payload = note({ iid: 12, userId: 7, username: 'somchai.dev', text: 'ลองใหม่' })
      const res = await hook(payload, { uuid: 'fake-uuid-retry' })
      expect(res.statusCode).toBe(503)
      expect(await app.deps.db.select().from(gitlabDeliveries)).toHaveLength(0)
      const retry = await hook(payload, { uuid: 'fake-uuid-retry' })
      expect(retry.json()).toEqual({ ok: true })
      expect((await eventsOf('gitlab.note'))[0]!.workItemId).toBe(id)
    })

    it('acknowledges other event kinds', async () => {
      const res = await hook({ object_kind: 'push', project: { id: 11 } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, ignored: true })
    })
  })
})
