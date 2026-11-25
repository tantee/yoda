import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentRuns, events, people, projects, runners, runnerSettings, tasks, workItems } from '../src/db/schema.js'
import { authenticateRunner } from '../src/runners/records.js'
import { hashToken, newRunnerToken } from '../src/runners/tokens.js'
import { latestTemplate } from '../src/workflow/seed.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let boss: Who
let dev: Who
let dev2: Who
let requester: Who

const devRunner = {
  name: 'my laptop',
  kind: 'dev-machine',
  accountType: 'org-plan',
  capabilities: ['code-change'],
  mode: 'on-demand',
  maxConcurrent: 1,
  workingHours: null,
}

async function create(who: Who, payload: Record<string, unknown> = devRunner) {
  return app.inject({ method: 'POST', url: '/runners', headers: auth(who), payload })
}

beforeEach(async () => {
  await resetDb(await testDb())
  app = await makeApp()
  boss = await login(app, 'boss')
  dev = await login(app, 'dev', { staff: true, name: 'Dev One' })
  dev2 = await login(app, 'dev2', { staff: true })
  requester = await login(app, 'req')
})
afterEach(() => app.close())

describe('runner tokens', () => {
  it('are prefixed, random and stored only as a SHA-256 hash', () => {
    const a = newRunnerToken()
    const b = newRunnerToken()
    expect(a.token).toMatch(/^yoda_rt_[A-Za-z0-9_-]{43}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(hashToken(a.token))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.prefix).toBe(a.token.slice(0, 12))
  })
})

describe('/runners', () => {
  it('staff create a dev-machine runner; the token is shown once', async () => {
    const res = await create(dev)
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.token).toMatch(/^yoda_rt_/)
    expect(body.runner).toMatchObject({ name: 'my laptop', kind: 'dev-machine', ownerId: dev.id, ownerName: 'Dev One', activeRuns: 0, paused: false, revokedAt: null })
    expect(JSON.stringify(body)).not.toContain('tokenHash')

    const list = await app.inject({ url: '/runners', headers: auth(dev) })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toHaveLength(1)
    expect(list.body).not.toContain(body.token)
    expect(list.body).not.toContain(hashToken(body.token))
    expect(list.body).not.toContain('tokenHash')

    const [row] = await (await testDb()).select().from(runners)
    expect(row!.tokenHash).toBe(hashToken(body.token))
    expect(row!.createdBy).toBe(dev.id)
  })

  it('staff may not create server runners or runners for someone else', async () => {
    expect((await create(dev, { ...devRunner, kind: 'server' })).statusCode).toBe(403)
    expect((await create(dev, { ...devRunner, ownerId: dev2.id })).statusCode).toBe(403)
    expect((await create(dev, { ...devRunner, ownerId: dev.id })).statusCode).toBe(201)
  })

  it('admin creates a server runner for another staff person, but not for a requester', async () => {
    const res = await create(boss, { ...devRunner, kind: 'server', accountType: 'api-key', mode: 'unattended', ownerId: dev.id })
    expect(res.statusCode).toBe(201)
    expect(res.json().runner).toMatchObject({ kind: 'server', ownerId: dev.id })
    const [row] = await (await testDb()).select().from(runners)
    expect(row!.createdBy).toBe(boss.id)
    expect((await create(boss, { ...devRunner, kind: 'server', ownerId: requester.id })).statusCode).toBe(422)
  })

  it('allows an unattended personal-subscription runner at creation', async () => {
    const res = await create(dev, { ...devRunner, accountType: 'personal-subscription', mode: 'unattended' })
    expect(res.statusCode).toBe(201)
  })

  it('requesters get 403', async () => {
    expect((await create(requester)).statusCode).toBe(403)
    expect((await app.inject({ url: '/runners', headers: auth(requester) })).statusCode).toBe(403)
  })

  it('a runner token does not authenticate REST routes', async () => {
    const { token } = (await create(dev)).json()
    for (const url of ['/runners', '/me']) {
      const res = await app.inject({ url, headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(401)
    }
  })

  it('lists own runners; admins see all with ?all=1', async () => {
    await create(dev)
    await create(dev2, { ...devRunner, name: 'other' })
    expect((await app.inject({ url: '/runners', headers: auth(dev) })).json().map((r: { name: string }) => r.name)).toEqual(['my laptop'])
    expect((await app.inject({ url: '/runners?all=1', headers: auth(dev) })).json()).toHaveLength(1)
    expect((await app.inject({ url: '/runners', headers: auth(boss) })).json()).toHaveLength(0)
    expect((await app.inject({ url: '/runners?all=1', headers: auth(boss) })).json()).toHaveLength(2)
  })

  it('PATCH by owner or admin; another staff gets 404; an empty patch is 422', async () => {
    const id = (await create(dev)).json().runner.id
    const patch = (who: Who, payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/runners/${id}`, headers: auth(who), payload })
    expect((await patch(dev2, { paused: true })).statusCode).toBe(404)
    const own = await patch(dev, { paused: true, name: 'renamed' })
    expect(own.statusCode).toBe(200)
    expect(own.json()).toMatchObject({ paused: true, name: 'renamed' })
    expect(own.body).not.toContain('tokenHash')
    expect((await patch(boss, { maxConcurrent: 2 })).json()).toMatchObject({ maxConcurrent: 2 })
    expect((await patch(dev, {})).statusCode).toBe(422)
    expect((await patch(dev, { maxConcurrent: 9 })).statusCode).toBe(400)
  })

  it('DELETE revokes: owner or admin; another staff gets 404', async () => {
    const id = (await create(dev)).json().runner.id
    expect((await app.inject({ method: 'DELETE', url: `/runners/${id}`, headers: auth(dev2) })).statusCode).toBe(404)
    const res = await app.inject({ method: 'DELETE', url: `/runners/${id}`, headers: auth(dev) })
    expect(res.statusCode).toBe(200)
    expect(res.json().revokedAt).not.toBeNull()
    // Revoked runners can no longer be changed.
    const patch = await app.inject({ method: 'PATCH', url: `/runners/${id}`, headers: auth(dev), payload: { paused: true } })
    expect(patch.statusCode).toBe(409)
  })
})

describe('authenticateRunner', () => {
  it('returns the runner and its owner for the right token, null otherwise', async () => {
    const db = await testDb()
    const { token, runner } = (await create(dev)).json()
    const ok = await authenticateRunner(db, `Bearer ${token}`)
    expect(ok?.runner.id).toBe(runner.id)
    expect(ok?.owner).toEqual({ id: dev.id, username: 'dev', displayName: 'Dev One', email: null, isStaff: true, isAdmin: false })
    expect(ok?.runner.lastSeenAt).not.toBeNull()

    expect(await authenticateRunner(db, undefined)).toBeNull()
    expect(await authenticateRunner(db, token)).toBeNull()
    expect(await authenticateRunner(db, `Bearer ${token.slice(0, -1)}x`)).toBeNull()
    expect(await authenticateRunner(db, `Bearer ${newRunnerToken().token}`)).toBeNull()
    expect(await authenticateRunner(db, `Bearer ${dev.token}`)).toBeNull()
  })

  it('throttles last_seen_at to once a minute', async () => {
    const db = await testDb()
    const { token, runner } = (await create(dev)).json()
    const recent = new Date(Date.now() - 30_000)
    await db.update(runners).set({ lastSeenAt: recent }).where(eq(runners.id, runner.id))
    await authenticateRunner(db, `Bearer ${token}`)
    const [a] = await db.select().from(runners)
    expect(a!.lastSeenAt!.getTime()).toBe(recent.getTime())
    const old = new Date(Date.now() - 120_000)
    await db.update(runners).set({ lastSeenAt: old }).where(eq(runners.id, runner.id))
    await authenticateRunner(db, `Bearer ${token}`)
    const [b] = await db.select().from(runners)
    expect(b!.lastSeenAt!.getTime()).toBeGreaterThan(old.getTime() + 60_000)
  })

  it('returns null after revoke', async () => {
    const db = await testDb()
    const { token, runner } = (await create(dev)).json()
    await app.inject({ method: 'DELETE', url: `/runners/${runner.id}`, headers: auth(dev) })
    expect(await authenticateRunner(db, `Bearer ${token}`)).toBeNull()
  })

  it('returns null when the owner is no longer staff; admins count as staff', async () => {
    const db = await testDb()
    const { token } = (await create(dev)).json()
    await db.update(people).set({ staffOverride: false }).where(eq(people.id, dev.id))
    expect(await authenticateRunner(db, `Bearer ${token}`)).toBeNull()
    await db.update(people).set({ isAdmin: true }).where(eq(people.id, dev.id))
    expect((await authenticateRunner(db, `Bearer ${token}`))?.owner).toMatchObject({ isStaff: true, isAdmin: true })
  })
})

describe('revoking a runner with running work', () => {
  it('releases its running runs; unassigned AI tasks reopen, assigned tasks stay with their person', async () => {
    const db = await testDb()
    const { runner } = (await create(dev)).json()
    const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
    const templateId = (await latestTemplate(db, 'software-change'))!.id
    const [wi] = await db.insert(workItems).values({ projectId: proj!.id, title: 'w', templateId, ownerId: dev.id }).returning()
    const base = { workItemId: wi!.id, projectId: proj!.id, stepKey: 's', attempt: 1, type: 'ai', role: 'DEV', state: 'in_progress' } as const
    const [aiTask] = await db.insert(tasks).values({ ...base, templateTaskKey: 'a', executor: 'ai' }).returning()
    const [mine] = await db.insert(tasks).values({ ...base, templateTaskKey: 'b', executor: 'human', assigneeId: dev.id }).returning()
    const lease = new Date(Date.now() + 600_000)
    for (const t of [aiTask!, mine!]) {
      await db.insert(agentRuns).values({ taskId: t.id, runnerId: runner.id, ownerId: dev.id, leaseExpiresAt: lease })
    }

    const res = await app.inject({ method: 'DELETE', url: `/runners/${runner.id}`, headers: auth(boss) })
    expect(res.statusCode).toBe(200)
    const runs = await db.select().from(agentRuns)
    expect(runs.map((r) => r.state)).toEqual(['released', 'released'])
    expect(runs.every((r) => r.endedAt !== null)).toBe(true)
    const [a] = await db.select().from(tasks).where(eq(tasks.id, aiTask!.id))
    const [b] = await db.select().from(tasks).where(eq(tasks.id, mine!.id))
    expect(a!.state).toBe('open')
    expect(b).toMatchObject({ state: 'in_progress', assigneeId: dev.id })
    const evs = await db.select().from(events).where(eq(events.type, 'run.released'))
    expect(evs).toHaveLength(2)
    expect(evs.every((e) => e.reason === 'runner_revoked')).toBe(true)
  })
})

describe('/admin/runner-settings', () => {
  it('admin reads and updates; staff get 403; an empty patch is 422', async () => {
    const get = await app.inject({ url: '/admin/runner-settings', headers: auth(boss) })
    expect(get.json()).toEqual({ paused: false, allowPersonalUnattended: false })
    const patch = await app.inject({ method: 'PATCH', url: '/admin/runner-settings', headers: auth(boss), payload: { paused: true } })
    expect(patch.json()).toEqual({ paused: true, allowPersonalUnattended: false })
    const [row] = await (await testDb()).select().from(runnerSettings)
    expect(row!.paused).toBe(true)
    expect((await app.inject({ method: 'PATCH', url: '/admin/runner-settings', headers: auth(boss), payload: {} })).statusCode).toBe(422)
    expect((await app.inject({ url: '/admin/runner-settings', headers: auth(dev) })).statusCode).toBe(403)
    const staffPatch = await app.inject({ method: 'PATCH', url: '/admin/runner-settings', headers: auth(dev), payload: { paused: false } })
    expect(staffPatch.statusCode).toBe(403)
  })
})
