import type { FastifyInstance } from 'fastify'
import type { DepartmentStatus, ProjectStatus, WorkItemDetail } from '@yoda/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../src/ai/gateway.js'
import { aiCalls, discussions, events, projectRepos, workItemRepos, workItems } from '../src/db/schema.js'
import { LiveBus } from '../src/live/bus.js'
import { bangkokDate } from '../src/status/health.js'
import { mockModels, resetDb, testConfig, testDb } from './helpers.js'
import { auth, login, makeApp, timelineOf, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let dev: Who
let qc: Who
let outsider: Who
let nurse: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function project(name: string, members: [Who, string[]][] = [[pm, ['PM']], [dev, ['DEV']], [qc, ['QC']]]): Promise<string> {
  const { id } = (await call(admin, 'POST', '/projects', { name })).json() as { id: string }
  for (const [who, roles] of members) {
    expect((await call(admin, 'PUT', `/projects/${id}/members/${who.id}`, { roles })).statusCode).toBe(200)
  }
  return id
}

async function createItem(projectId: string, body: Record<string, unknown> = {}): Promise<WorkItemDetail> {
  const res = await call(pm, 'POST', `/projects/${projectId}/work-items`, { title: 'แก้รายงานแล็บ', templateKey: 'bug-fix', ...body })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const status = async (who: Who, projectId: string): Promise<ProjectStatus> => {
  const res = await call(who, 'GET', `/projects/${projectId}/status`)
  expect(res.statusCode).toBe(200)
  return res.json()
}

const daysAgo = (n: number) => sql`now() - make_interval(days => ${n})`
const bangkokDaysAgo = (n: number) => bangkokDate(new Date(Date.now() - n * 86400000))

/** Moves the item's creation and every event back `n` days. */
async function idle(itemId: string, n: number): Promise<void> {
  const db = await testDb()
  await db.update(events).set({ createdAt: daysAgo(n) }).where(eq(events.workItemId, itemId))
  await db.update(workItems).set({ createdAt: daysAgo(n) }).where(eq(workItems.id, itemId))
}

async function discussion(projectId: string, priority: string, ageDays: number, state = 'open'): Promise<string> {
  const db = await testDb()
  const [d] = await db
    .insert(discussions)
    .values({ projectId, question: `เรื่อง ${priority}`, priority, state, raisedBy: pm.id, createdAt: daysAgo(ageDays) })
    .returning({ id: discussions.id })
  return d!.id
}

describe('status routes', () => {
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

  it('a project with no items, or only cancelled ones, is on track with zeros', async () => {
    const empty = await project('ว่าง')
    const cancelledOnly = await project('ยกเลิกหมด')
    const item = await createItem(cancelledOnly)
    expect((await call(pm, 'POST', `/work-items/${item.id}/cancel`)).statusCode).toBe(200)
    await idle(item.id, 10)

    for (const id of [empty, cancelledOnly]) {
      const s = await status(pm, id)
      expect(s).toMatchObject({
        health: 'on_track',
        reasons: [],
        activeItems: 0,
        overdueItems: 0,
        openDiscussions: 0,
        countsByStep: {},
        stepNames: {},
        aiSpendUsd: 0,
        aiBudgetUsd: null,
        board: [],
        discussions: [],
        repos: [],
        weeklySummary: null,
        weeklyInProgress: null,
      })
      expect(s.people.map((p) => p.name).sort()).toEqual(['สมชาย', 'สมศรี', 'สมหญิง'].sort())
      expect(s.people.every((p) => p.openTasks >= 0 && Number.isInteger(p.inProgressTasks))).toBe(true)
    }

    const dept = (await call(pm, 'GET', '/status')).json() as DepartmentStatus
    expect(dept.projects.map((p) => p.health)).toEqual(['on_track', 'on_track'])
    expect(dept.totals).toEqual({ activeItems: 0, overdueItems: 0, openDiscussions: 0, aiSpendUsd: 0 })
  })

  it('one overdue item puts the project at risk', async () => {
    const id = await project('แล็บ')
    const item = await createItem(id)
    const res = await call(pm, 'PATCH', `/work-items/${item.id}`, { targetDate: bangkokDaysAgo(1) })
    expect(res.statusCode).toBe(200)
    expect((res.json() as WorkItemDetail).targetDate).toBe(bangkokDaysAgo(1))
    // A target of today is not overdue yet.
    const today = await createItem(id, { title: 'วันนี้' })
    expect((await call(pm, 'PATCH', `/work-items/${today.id}`, { targetDate: bangkokDate() })).statusCode).toBe(200)

    const s = await status(pm, id)
    expect(s.health).toBe('at_risk')
    expect(s.reasons).toEqual([{ code: 'overdue', count: 1, sample: [{ id: item.id, title: item.title }] }])
    expect(s.overdueItems).toBe(1)
    const card = s.board.flatMap((c) => c.items).find((c) => c.id === item.id)
    expect(card).toMatchObject({ overdue: true, targetDate: bangkokDaysAgo(1), stuckDays: null, ownerName: 'สมศรี' })
  })

  it('an item with no events for 6 days blocks the project as stuck', async () => {
    const id = await project('แล็บ')
    const item = await createItem(id)
    await createItem(id, { title: 'ยังเดินอยู่' })
    await idle(item.id, 6)
    const s = await status(pm, id)
    expect(s.health).toBe('blocked')
    expect(s.reasons).toEqual([{ code: 'stuck', count: 1, sample: [{ id: item.id, title: item.title }] }])
    expect(s.board.flatMap((c) => c.items).find((c) => c.id === item.id)?.stuckDays).toBe(6)
  })

  it('an urgent discussion open 4 days blocks; a high one open 8 days is a risk', async () => {
    const id = await project('แล็บ')
    await discussion(id, 'urgent', 2)
    await discussion(id, 'high', 8, 'scheduled')
    await discussion(id, 'urgent', 9, 'decided')
    let s = await status(pm, id)
    expect(s.health).toBe('at_risk')
    expect(s.reasons.map((r) => r.code)).toEqual(['high_discussion'])
    expect(s.openDiscussions).toBe(2)

    const urgent = await discussion(id, 'urgent', 4)
    s = await status(pm, id)
    expect(s.health).toBe('blocked')
    expect(s.reasons.map((r) => r.code)).toEqual(['urgent_discussion', 'high_discussion'])
    expect(s.reasons[0]).toEqual({ code: 'urgent_discussion', count: 1, sample: [{ id: urgent, title: 'เรื่อง urgent' }] })
    expect(s.discussions.map((d) => d.priority)).toEqual(['urgent', 'urgent', 'high'])
  })

  it('a failed issue sync blocks the project, and AI spend near the budget is a risk', async () => {
    const db = await testDb()
    const id = await project('แล็บ')
    const item = await createItem(id)
    const [repo] = await db
      .insert(projectRepos)
      .values({ projectId: id, gitlabProjectId: 7, pathWithNamespace: 'group/app', webUrl: 'https://gitlab.example.org/group/app' })
      .returning()
    await db.insert(workItemRepos).values({ workItemId: item.id, repoId: repo!.id, syncStatus: 'failed', syncError: 'http_500' })
    // A finished item's failed sync no longer blocks the project.
    const done = await createItem(id, { title: 'เสร็จแล้ว' })
    await db.update(workItems).set({ state: 'done', currentStepKey: null }).where(eq(workItems.id, done.id))
    await db
      .insert(workItemRepos)
      .values({ workItemId: done.id, repoId: repo!.id, syncStatus: 'failed', syncError: 'http_500' })
      .onConflictDoUpdate({ target: [workItemRepos.workItemId, workItemRepos.repoId], set: { syncStatus: 'failed', syncError: 'http_500' } })
    expect((await call(admin, 'PATCH', `/projects/${id}`, { aiBudgetUsd: 10 })).statusCode).toBe(200)
    await db.insert(aiCalls).values({ projectId: id, job: 'draft', ok: true, costUsd: '8.5' })

    const s = await status(pm, id)
    expect(s.health).toBe('blocked')
    expect(s.reasons).toEqual([
      { code: 'sync_failed', count: 1, sample: [{ id: item.id, title: item.title }] },
      { code: 'ai_budget', count: 85, sample: [] },
    ])
    expect(s).toMatchObject({ aiSpendUsd: 8.5, aiBudgetUsd: 10 })
    expect(s.repos.map((r) => r.pathWithNamespace)).toEqual(['group/app'])

    const dept = (await call(admin, 'GET', '/status')).json() as DepartmentStatus
    expect(dept.projects[0]).toMatchObject({ health: 'blocked', aiSpendUsd: 8.5, aiBudgetUsd: 10 })
    expect(dept.totals.aiSpendUsd).toBe(8.5)
  })

  it('countsByStep follows the active items\' current steps', async () => {
    const db = await testDb()
    const id = await project('แล็บ')
    const a = await createItem(id)
    await createItem(id)
    const c = await createItem(id)
    const gone = await createItem(id)
    await db.update(workItems).set({ currentStepKey: 'dev' }).where(eq(workItems.id, a.id))
    await db.update(workItems).set({ currentStepKey: 'qc' }).where(eq(workItems.id, c.id))
    expect((await call(pm, 'POST', `/work-items/${gone.id}/cancel`)).statusCode).toBe(200)

    const s = await status(pm, id)
    expect(s.countsByStep).toEqual({ intake: 1, dev: 1, qc: 1 })
    expect(s.activeItems).toBe(3)
    expect(s.board.map((col) => [col.stepKey, col.items.length])).toEqual([['intake', 1], ['dev', 1], ['qc', 1], ['close', 0]])
    expect(s.board[0]!.stepName.th).toBeTruthy()
    expect(s.recentEvents.length).toBeGreaterThan(0)
    expect(s.recentEvents[0]!.type).toBe('work_item.cancelled')
    expect(s.recentEvents[0]!.workItemTitle).toBe(gone.title)
    const dept = (await call(pm, 'GET', '/status')).json() as DepartmentStatus
    expect(dept.projects[0]!.countsByStep).toEqual({ intake: 1, dev: 1, qc: 1 })
    // Step names come with the counts (the board's localized names), so the portal needs no template lookup.
    const names = dept.projects[0]!.stepNames
    expect(Object.keys(names).sort()).toEqual(['dev', 'intake', 'qc'])
    expect(names.intake).toEqual(s.board[0]!.stepName)
    expect(s.stepNames.dev).toEqual(s.board.find((col) => col.stepKey === 'dev')!.stepName)
  })

  it('the project status says whether AI (the fast model) is configured', async () => {
    const id = await project('แล็บ')
    expect((await status(pm, id)).aiConfigured).toBe(true)
    const bare = await makeApp({ ai: new AiGateway({ db: await testDb(), bus: new LiveBus(), models: mockModels({ fast: null, ids: { draft: 'anthropic:claude-opus-5-5', fast: null, embed: null } }), config: testConfig() }) })
    try {
      const res = await bare.inject({ url: `/projects/${id}/status`, headers: auth(pm) })
      expect((res.json() as ProjectStatus).aiConfigured).toBe(false)
    } finally {
      await bare.close()
    }
  })

  it('people load counts open and in-progress staff work', async () => {
    const id = await project('แล็บ')
    const item = await createItem(id)
    const task = item.tasks.find((t) => t.state === 'open' || t.state === 'proposed')!
    expect((await call(pm, 'POST', `/tasks/${task.id}/assign`, { personId: dev.id })).statusCode).toBe(200)
    let load = (await status(pm, id)).people.find((p) => p.personId === dev.id)!
    expect(load).toMatchObject({ name: 'สมชาย', roles: ['DEV'], openTasks: 1, inProgressTasks: 0, todayAssigned: 0 })
    expect((await call(dev, 'POST', `/tasks/${task.id}/start`)).statusCode).toBe(200)
    load = (await status(pm, id)).people.find((p) => p.personId === dev.id)!
    expect(load).toMatchObject({ openTasks: 0, inProgressTasks: 1 })
  })

  it('refuses requesters with 403 on both routes', async () => {
    const id = await project('แล็บ')
    expect((await call(nurse, 'GET', '/status')).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/projects/${id}/status`)).statusCode).toBe(403)
  })

  it('hides projects from non-members: 404 on the project, absent from /status; admins see all', async () => {
    const mine = await project('ของฉัน')
    const theirs = await project('ของคนอื่น', [[pm, ['PM']]])
    expect((await call(outsider, 'GET', `/projects/${theirs}/status`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', '/projects/00000000-0000-4000-8000-000000000000/status')).statusCode).toBe(404)
    expect(((await call(outsider, 'GET', '/status')).json() as DepartmentStatus).projects).toEqual([])
    const devView = (await call(dev, 'GET', '/status')).json() as DepartmentStatus
    expect(devView.projects.map((p) => p.projectId)).toEqual([mine])
    expect((await call(dev, 'GET', `/projects/${theirs}/status`)).statusCode).toBe(404)
    const adminView = (await call(admin, 'GET', '/status')).json() as DepartmentStatus
    expect(adminView.projects.map((p) => p.projectId).sort()).toEqual([mine, theirs].sort())
    expect((await call(admin, 'GET', `/projects/${theirs}/status`)).statusCode).toBe(200)
  })
})

describe('work item target date', () => {
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

  it('the owner or a PM sets it; other members get 403; it records an event', async () => {
    const id = await project('แล็บ')
    const item = await createItem(id, { ownerId: dev.id })
    expect((await call(qc, 'PATCH', `/work-items/${item.id}`, { targetDate: '2026-12-01' })).statusCode).toBe(403)
    expect((await call(nurse, 'PATCH', `/work-items/${item.id}`, { targetDate: '2026-12-01' })).statusCode).toBe(403)
    expect((await call(outsider, 'PATCH', `/work-items/${item.id}`, { targetDate: '2026-12-01' })).statusCode).toBe(404)

    const owner = await call(dev, 'PATCH', `/work-items/${item.id}`, { targetDate: '2026-12-01' })
    expect(owner.statusCode).toBe(200)
    const byPm = await call(pm, 'PATCH', `/work-items/${item.id}`, { targetDate: null })
    expect(byPm.statusCode).toBe(200)
    const d = byPm.json() as WorkItemDetail
    expect(d.targetDate).toBeNull()
    const changes = (await timelineOf(app, pm, item.id)).filter((e) => e.type === 'work_item.target_date_changed')
    expect(changes.map((e) => e.payload)).toEqual([
      { from: null, to: '2026-12-01' },
      { from: '2026-12-01', to: null },
    ])
    // Unchanged → no new event.
    expect((await call(pm, 'PATCH', `/work-items/${item.id}`, { targetDate: null })).statusCode).toBe(200)
    expect((await timelineOf(app, pm, item.id)).filter((e) => e.type === 'work_item.target_date_changed')).toHaveLength(2)
  })

  it('validates the date and refuses empty patches and finished items', async () => {
    const id = await project('แล็บ')
    const item = await createItem(id)
    for (const targetDate of ['2026-02-30', '01/12/2026', '2026-12-01T00:00:00Z']) {
      expect((await call(pm, 'PATCH', `/work-items/${item.id}`, { targetDate })).statusCode).toBe(400)
    }
    expect((await call(pm, 'PATCH', `/work-items/${item.id}`, { title: 'x' })).statusCode).toBe(400)
    expect((await call(pm, 'PATCH', `/work-items/${item.id}`, {})).statusCode).toBe(422)
    expect((await call(pm, 'POST', `/work-items/${item.id}/cancel`)).statusCode).toBe(200)
    expect((await call(pm, 'PATCH', `/work-items/${item.id}`, { targetDate: '2026-12-01' })).statusCode).toBe(409)
  })
})
