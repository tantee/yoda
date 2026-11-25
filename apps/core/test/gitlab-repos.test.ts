import type { FastifyInstance } from 'fastify'
import type { GitLabStatus, Repo, WorkItemCode } from '@yoda/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitLabClient } from '../src/gitlab/client.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let fake: FakeGitLab
let admin: Who
let pm: Who
let dev: Who
let nurse: Who
let projectId: string

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function setup(connected = true) {
  fake = await startFakeGitLab()
  fake.addProject('dept/lab-report')
  fake.addProject('dept/lab-web')
  app = await makeApp({ gitlab: connected ? new GitLabClient({ baseUrl: fake.url, token: 'secret-token', retryBaseMs: 1 }) : null })
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  nurse = await login(app, 'nurse')
  projectId = ((await call(admin, 'POST', '/projects', { name: 'lab' })).json() as { id: string }).id
  await call(admin, 'PUT', `/projects/${projectId}/members/${pm.id}`, { roles: ['PM'] })
  await call(admin, 'PUT', `/projects/${projectId}/members/${dev.id}`, { roles: ['DEV'] })
}

const link = async (path: string) => call(pm, 'POST', `/projects/${projectId}/repos`, { path })
const newItem = async () =>
  ((await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 't', templateKey: 'bug-fix' })).json() as { id: string }).id

beforeEach(async () => {
  await resetDb(await testDb())
})
afterEach(async () => {
  await app?.close()
  await fake?.stop()
})

describe('repository links', () => {
  beforeEach(() => setup())

  it('PM links a repo; list, duplicate and unknown path', async () => {
    const res = await link('dept/lab-report')
    expect(res.statusCode).toBe(201)
    const repo = res.json() as Repo
    expect(repo.id).toBeTruthy()
    expect(repo.webUrl).toBe(`${fake.url}/dept/lab-report`)
    expect((await call(dev, 'GET', `/projects/${projectId}/repos`)).json()).toHaveLength(1)
    expect((await link('dept/lab-report')).statusCode).toBe(409)
    const unknown = await link('dept/nope')
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json()).toEqual({ error: 'repo_not_found' })
  })

  it('refuses DEV-only, requesters and non-members', async () => {
    expect((await call(dev, 'POST', `/projects/${projectId}/repos`, { path: 'dept/lab-report' })).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/projects/${projectId}/repos`)).statusCode).toBe(403)
    const other = await login(app, 'other', { staff: true })
    expect((await call(other, 'GET', `/projects/${projectId}/repos`)).statusCode).toBe(404)
  })

  it('new work items get the project repos; PM narrows them until Dev starts', async () => {
    const a = (await link('dept/lab-report')).json() as Repo
    await link('dept/lab-web')
    const id = await newItem()
    const code = (await call(pm, 'GET', `/work-items/${id}/code`)).json() as WorkItemCode
    expect(code.repos).toHaveLength(2)
    expect(code.connected).toBe(true)
    expect(code.issues).toHaveLength(2)

    const put = await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id] })
    expect(put.statusCode).toBe(200)
    expect((put.json() as WorkItemCode).repos.map((r) => r.id)).toEqual([a.id])
    expect((await call(dev, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id] })).statusCode).toBe(403)
    expect((await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: ['00000000-0000-4000-8000-000000000000'] })).statusCode).toBe(422)
    expect((await call(nurse, 'GET', `/work-items/${id}/code`)).statusCode).toBe(403)
  })

  it('refuses changes once the code-change task exists', async () => {
    const a = (await link('dept/lab-report')).json() as Repo
    const id = await newItem()
    const { db } = app.deps
    const { tasks } = await import('../src/db/schema.js')
    const { eq } = await import('drizzle-orm')
    const rows = await db.select().from(tasks).where(eq(tasks.workItemId, id))
    // Bug-fix starts with intake tasks only; force the Dev step's task into existence.
    expect(rows.some((t) => t.templateTaskKey === 'implement')).toBe(false)
    const [any] = rows
    await db.insert(tasks).values({ ...any!, id: undefined, templateTaskKey: 'implement', stepKey: await devStepKey(id) } as never)
    const res = await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id] })
    expect(res.statusCode).toBe(409)
  })

  it('PUT refuses a repo of another project, and removing a repo whose issue exists', async () => {
    const a = (await link('dept/lab-report')).json() as Repo
    const b = (await link('dept/lab-web')).json() as Repo
    const otherProject = ((await call(admin, 'POST', '/projects', { name: 'other' })).json() as { id: string }).id
    await call(admin, 'PUT', `/projects/${otherProject}/members/${pm.id}`, { roles: ['PM'] })
    const foreign = (await call(pm, 'POST', `/projects/${otherProject}/repos`, { path: 'dept/lab-web' })).json() as Repo
    const id = await newItem()
    const cross = await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id, foreign.id] })
    expect(cross.statusCode).toBe(422)
    expect(cross.json()).toEqual({ error: 'repo_not_found' })

    const { workItemRepos } = await import('../src/db/schema.js')
    const { and, eq } = await import('drizzle-orm')
    await app.deps.db.update(workItemRepos).set({ issueIid: 5 }).where(and(eq(workItemRepos.workItemId, id), eq(workItemRepos.repoId, b.id)))
    const drop = await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id] })
    expect(drop.statusCode).toBe(409)
    expect(drop.json()).toEqual({ error: 'invalid_state' })
    expect(((await call(pm, 'GET', `/work-items/${id}/code`)).json() as WorkItemCode).repos).toHaveLength(2)
    // Dropping the repo without an issue is fine while the one with it stays.
    expect((await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [b.id] })).statusCode).toBe(200)
    expect((await call(pm, 'PUT', `/work-items/${id}/repos`, { repoIds: [a.id, b.id] })).statusCode).toBe(200)
  })

  it('non-member staff get 404 on work item code', async () => {
    await link('dept/lab-report')
    const id = await newItem()
    const other = await login(app, 'other', { staff: true })
    expect((await call(other, 'GET', `/work-items/${id}/code`)).statusCode).toBe(404)
    expect((await call(other, 'PUT', `/work-items/${id}/repos`, { repoIds: [] })).statusCode).toBe(404)
  })

  it('deletes a repo unless an issue exists in it', async () => {
    const a = (await link('dept/lab-report')).json() as Repo
    const b = (await link('dept/lab-web')).json() as Repo
    const id = await newItem()
    const { workItemRepos } = await import('../src/db/schema.js')
    const { and, eq } = await import('drizzle-orm')
    await app.deps.db.update(workItemRepos).set({ issueIid: 3 }).where(and(eq(workItemRepos.workItemId, id), eq(workItemRepos.repoId, a.id)))
    expect((await call(pm, 'DELETE', `/projects/${projectId}/repos/${a.id}`)).statusCode).toBe(409)
    expect((await call(dev, 'DELETE', `/projects/${projectId}/repos/${b.id}`)).statusCode).toBe(403)
    expect((await call(pm, 'DELETE', `/projects/${projectId}/repos/${b.id}`)).statusCode).toBe(204)
    expect((await call(dev, 'GET', `/projects/${projectId}/repos`)).json()).toHaveLength(1)
  })

  it('admin status shows the bot and never the token', async () => {
    const res = await call(admin, 'GET', '/admin/gitlab')
    expect(res.statusCode).toBe(200)
    expect(res.json() as GitLabStatus).toEqual({ configured: true, reachable: true, botUsername: 'yoda-bot', lastWebhookAt: null })
    expect(res.body).not.toContain('secret-token')
    expect((await call(pm, 'GET', '/admin/gitlab')).statusCode).toBe(403)
  })
})

describe('without GitLab configured', () => {
  beforeEach(() => setup(false))

  it('linking answers gitlab_not_connected; status says not configured', async () => {
    const res = await link('dept/lab-report')
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'gitlab_not_connected' })
    expect((await call(admin, 'GET', '/admin/gitlab')).json()).toMatchObject({ configured: false, reachable: null, botUsername: null })
  })
})

async function devStepKey(workItemId: string): Promise<string> {
  const { workItems } = await import('../src/db/schema.js')
  const { eq } = await import('drizzle-orm')
  const { templateById } = await import('../src/workflow/seed.js')
  const [item] = await app.deps.db.select().from(workItems).where(eq(workItems.id, workItemId))
  const def = (await templateById(app.deps.db, item!.templateId))!
  return def.steps.find((s) => s.tasks.some((t) => t.capability === 'code-change'))!.key
}
