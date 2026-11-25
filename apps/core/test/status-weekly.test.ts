import { MockLanguageModelV4 } from 'ai/test'
import type { FastifyInstance } from 'fastify'
import type { LiveEvent, Me, ProjectStatus } from '@yoda/shared'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../src/ai/gateway.js'
import type { AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { aiCalls, discussions, events, knowledgeEntries, people, projectMembers, projects, tasks, workItems } from '../src/db/schema.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { LiveBus } from '../src/live/bus.js'
import { createEntry } from '../src/knowledge/service.js'
import { weeklySummaries } from '../src/status/queries.js'
import { isoWeek, queueWeeklyRegenerate, runWeeklySummary, summaryWeek, weekStart, weeklyMaterial } from '../src/status/weekly.js'
import { runWork } from '../src/work/context.js'
import { createWorkItem } from '../src/work/engine.js'
import { textStream } from './ai-mocks.js'
import { mockModels, resetDb, testConfig, testDb, testDeps } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

/** Records every send; `weekly-summary-project` runs only when `runWeekly` is set. */
class SpyQueue extends InlineJobQueue {
  sent: { name: JobName; id: string }[] = []
  runWeekly = false
  override async send(name: JobName, data: { id: string }): Promise<void> {
    this.sent.push({ name, id: data.id })
    if (name === 'weekly-summary-project' && !this.runWeekly) return
    await super.send(name, data)
  }
  ids = (name: JobName) => this.sent.filter((j) => j.name === name).map((j) => j.id)
}

const REQUESTER_NAME = 'สมปอง ผู้ขอ'

let db: Db
let deps: AppDeps
let jobs: SpyQueue
let prompts: string[]

async function person(name: string, staff = true): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: `u${Math.random()}`, displayName: name, staffOverride: staff })
    .returning()
  return { id: p!.id, username: p!.username, displayName: name, email: null, isStaff: staff, isAdmin: false }
}

const daysAgo = (n: number) => sql`now() - make_interval(days => ${n})`
const sinceWeek = () => new Date(Date.now() - 7 * 86400000)

/** A project (PM, a requester) with one active item asked for by the requester. */
async function setup(o: { noAi?: boolean; budget?: string } = {}) {
  const pm = await person('pm')
  const requester = await person(REQUESTER_NAME, false)
  const [proj] = await db
    .insert(projects)
    .values({ name: 'แล็บ', autonomy: 'auto-assign', noAi: o.noAi ?? false, aiBudgetUsd: o.budget ?? null, createdBy: pm.id })
    .returning()
  const projectId = proj!.id
  await db.insert(projectMembers).values({ projectId, personId: pm.id, roles: ['PM'] })
  const workItemId = await runWork(deps, { id: pm.id, kind: 'person' }, (ctx) =>
    createWorkItem(ctx, pm, projectId, { title: 'แก้รายงานช้า', description: `คำขอของ ${REQUESTER_NAME}`, templateKey: 'bug-fix', priority: 'normal' }),
  )
  await db.update(workItems).set({ requesterId: requester.id }).where(eq(workItems.id, workItemId))
  return { projectId, workItemId, pm, requester }
}

async function event(s: { projectId: string; workItemId: string }, type: string, ageDays: number, actorId: string | null = null) {
  await db.insert(events).values({ projectId: s.projectId, workItemId: s.workItemId, type, actorId, createdAt: daysAgo(ageDays) })
}

const weeklyEntries = (projectId: string) =>
  db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), like(knowledgeEntries.sourceRef, 'weekly:%')))
    .orderBy(asc(knowledgeEntries.version))

const typedEvents = (projectId: string, type: string) =>
  db.select().from(events).where(and(eq(events.projectId, projectId), eq(events.type, type)))

beforeEach(async () => {
  db = await testDb()
  await resetDb(db)
  prompts = []
  const model = new MockLanguageModelV4({
    modelId: 'claude-haiku-5-5',
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt))
      return { stream: textStream(`## ความคืบหน้า\nสรุปรอบที่ ${prompts.length}`) }
    },
  })
  jobs = new SpyQueue({ onError: (err, name, id) => console.warn(`job ${name} ${id} failed`, err) })
  deps = await testDeps({
    jobs,
    ai: new AiGateway({ db, bus: new LiveBus(), models: mockModels({ fast: model }), config: testConfig() }),
  })
})

afterEach(async () => {
  await jobs.drain()
})

describe('isoWeek', () => {
  it.each([
    ['2026-11-25T05:00:00Z', '2026-W48'],
    ['2026-12-31T05:00:00Z', '2026-W53'],
    ['2027-01-01T05:00:00Z', '2026-W53'],
    ['2027-01-04T05:00:00Z', '2027-W01'],
    ['2024-12-30T05:00:00Z', '2025-W01'],
    ['2021-01-03T05:00:00Z', '2020-W53'],
  ])('%s → %s', (at, week) => {
    expect(isoWeek(new Date(at))).toBe(week)
  })

  it.each([
    ['2026-W48', '2026-11-22T17:00:00.000Z'],
    ['2026-W53', '2026-12-27T17:00:00.000Z'],
    ['2027-W01', '2027-01-03T17:00:00.000Z'],
    ['2025-W01', '2024-12-29T17:00:00.000Z'],
  ])('weekStart(%s) is Monday 00:00 Bangkok, %s', (week, at) => {
    expect(weekStart(week).toISOString()).toBe(at)
    expect(isoWeek(weekStart(week))).toBe(week)
  })

  it('uses the Asia/Bangkok date, not UTC', () => {
    // Sunday 17:30 UTC is already Monday 00:30 in Bangkok.
    expect(isoWeek(new Date('2027-01-03T17:30:00Z'))).toBe('2027-W01')
    expect(isoWeek(new Date('2027-01-03T17:30:00Z'), 'UTC')).toBe('2026-W53')
  })
})

describe('weeklyMaterial', () => {
  it('covers the last 7 days, fenced, without requester names or no-AI entries', async () => {
    const s = await setup()
    await event(s, 'task.accepted', 3, s.requester.id)
    await event(s, 'gitlab.mr_merged', 10)
    const ctx = (fn: Parameters<typeof runWork<string>>[2]) => runWork(deps, { id: null, kind: 'system' }, fn)
    await ctx((c) =>
      createEntry(c, null, { scope: 'work_item', workItemId: s.workItemId, type: 'document', title: 'สเปก', body: `ยืนยันแล้ว ส่งให้ ${REQUESTER_NAME}`, status: 'confirmed', noAi: false }),
    )
    await ctx((c) =>
      createEntry(c, null, { scope: 'project', projectId: s.projectId, type: 'document', title: 'ลับ', body: 'ห้ามส่ง AI', status: 'confirmed', noAi: true }),
    )
    await ctx((c) =>
      createEntry(c, null, { scope: 'work_item', workItemId: s.workItemId, type: 'progress', title: 'บันทึก', body: 'แก้ index แล้ว', status: 'draft', sourceKind: 'ai', noAi: false }),
    )
    await db.insert(discussions).values({
      projectId: s.projectId,
      workItemId: s.workItemId,
      question: 'ใช้ฐานข้อมูลไหน',
      priority: 'normal',
      state: 'decided',
      decision: 'ใช้ Postgres',
      raisedBy: s.pm.id,
      decidedBy: s.pm.id,
      decidedAt: daysAgo(1),
    })
    // A requester's own task result is theirs, not the team's progress.
    const [t] = await db.select().from(tasks).where(eq(tasks.workItemId, s.workItemId)).limit(1)
    await db.update(tasks).set({ state: 'accepted', result: { text: 'ผลงาน: เร็วขึ้น 3 เท่า', attachmentIds: [] } }).where(eq(tasks.id, t!.id))

    const m = await weeklyMaterial(db, s.projectId, sinceWeek())
    expect(m).toContain('task.accepted')
    expect(m).toContain('แก้รายงานช้า')
    expect(m).not.toContain('gitlab.mr_merged')
    expect(m).toContain('ใช้ Postgres')
    expect(m).toContain('สเปก')
    expect(m).toContain('ผลงาน: เร็วขึ้น 3 เท่า')
    expect(m).toMatch(/\[UNVERIFIED DRAFT\][^\n]*บันทึก/)
    expect(m).not.toContain('ห้ามส่ง AI')
    expect(m).not.toContain('สมปอง')
    expect(m).toContain('~~~text')
    expect(m.length).toBeLessThanOrEqual(40_000)
  })

  it('redacts Latin requester names on word boundaries only, from 3 letters', async () => {
    const s = await setup()
    const ann = await person('Ann', false)
    const jo = await person('Jo', false)
    for (const r of [ann, jo]) {
      const id = await runWork(deps, { id: s.pm.id, kind: 'person' }, (ctx) =>
        createWorkItem(ctx, s.pm, s.projectId, { title: `item ${r.displayName}x`, description: '', templateKey: 'bug-fix', priority: 'normal' }),
      )
      await db.update(workItems).set({ requesterId: r.id }).where(eq(workItems.id, id))
    }
    await runWork(deps, { id: null, kind: 'system' }, (c) =>
      createEntry(c, null, { scope: 'project', projectId: s.projectId, type: 'document', title: 'notes', body: 'Joint review with Ann; Annual plan', status: 'confirmed', noAi: false }),
    )
    const m = await weeklyMaterial(db, s.projectId, sinceWeek())
    expect(m).toContain('Joint review with [ผู้ขอ / requester]; Annual plan')
  })

  it('is empty for a quiet week', async () => {
    const s = await setup()
    await db.update(events).set({ createdAt: daysAgo(9) }).where(eq(events.projectId, s.projectId))
    expect(await weeklyMaterial(db, s.projectId, sinceWeek())).toBe('')
  })

  it('is clipped to 40 000 characters', async () => {
    const s = await setup()
    await db.insert(events).values(
      Array.from({ length: 300 }, () => ({ projectId: s.projectId, workItemId: s.workItemId, type: 'task.started' })),
    )
    await db.update(workItems).set({ title: 'ย'.repeat(400) }).where(eq(workItems.id, s.workItemId))
    const m = await weeklyMaterial(db, s.projectId, sinceWeek())
    expect(m.length).toBeLessThanOrEqual(40_000)
    expect(m.endsWith('~~~')).toBe(true)
  })
})

describe('runWeeklySummary', () => {
  const week = isoWeek(new Date())

  it('writes one draft entry per project-week; a second run is a no-op with no AI call', async () => {
    const s = await setup()
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: false })
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('สมปอง')
    const rows = await weeklyEntries(s.projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'project',
      type: 'document',
      sourceKind: 'ai',
      status: 'draft',
      sourceRef: `weekly:${s.projectId}:${week}`,
      title: `สรุปประจำสัปดาห์ ${week} / Weekly summary ${week}`,
      body: '## ความคืบหน้า\nสรุปรอบที่ 1',
      version: 1,
    })
    expect(await typedEvents(s.projectId, 'status.weekly_summary')).toHaveLength(1)

    // The project status shows it as the week in progress (this week is not over yet).
    const app = await makeApp({ jobs })
    try {
      const boss = await login(app, 'boss')
      const res = await app.inject({ url: `/projects/${s.projectId}/status`, headers: auth(boss) })
      const status = res.json() as ProjectStatus
      expect(status.currentWeek).toBe(week)
      expect(status.weeklyInProgress).toMatchObject({ entryId: rows[0]!.id, week, status: 'draft' })
      expect(status.weeklySummary).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('force replaces the entry as a new version, back to draft', async () => {
    const s = await setup()
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: false })
    await db.update(knowledgeEntries).set({ status: 'confirmed' }).where(like(knowledgeEntries.sourceRef, 'weekly:%'))
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    expect(prompts).toHaveLength(2)
    const rows = await weeklyEntries(s.projectId)
    expect(rows.map((r) => [r.version, r.supersededAt === null, r.status])).toEqual([
      [1, false, 'confirmed'],
      [2, true, 'draft'],
    ])
    expect(rows[1]!.lineageId).toBe(rows[0]!.lineageId)
    expect(rows[1]!.body).toBe('## ความคืบหน้า\nสรุปรอบที่ 2')
    // The previous summary is not material for the next one.
    expect(prompts[1]).not.toContain('สรุปรอบที่ 1')
    // Two AI summaries in one test: slow under a loaded run, so it gets more than the 5 s default.
  }, 15_000)

  it('skips no-AI projects: no AI call, no entry', async () => {
    const s = await setup({ noAi: true })
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    expect(prompts).toHaveLength(0)
    expect(await weeklyEntries(s.projectId)).toHaveLength(0)
  })

  it('skips a quiet project: no AI call, no entry', async () => {
    const s = await setup()
    await db.update(events).set({ createdAt: daysAgo(9) }).where(eq(events.projectId, s.projectId))
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: false })
    expect(prompts).toHaveLength(0)
    expect(await weeklyEntries(s.projectId)).toHaveLength(0)
  })

  it('a budget refusal records a skipped event and writes nothing', async () => {
    const s = await setup({ budget: '1' })
    await db.insert(aiCalls).values({ projectId: s.projectId, job: 'draft', ok: true, costUsd: '2' })
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: false })
    expect(prompts).toHaveLength(0)
    expect(await weeklyEntries(s.projectId)).toHaveLength(0)
    // A rerun (restart, regenerate) records the skip once per project-week.
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    const skipped = await typedEvents(s.projectId, 'status.weekly_summary_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ reason: 'budget_exceeded', actorKind: 'system', payload: { week } })
  })
})

describe('weekly summary outcome (live only)', () => {
  const week = isoWeek(new Date())
  let seen: LiveEvent[]
  let unsubscribe: () => void
  beforeEach(() => {
    seen = []
    unsubscribe = deps.bus.subscribe((e) => {
      if (e.type === 'status.weekly_summary_outcome') seen.push(e)
    })
  })
  afterEach(() => unsubscribe())
  const outcomes = () => seen.map((e) => e.payload)

  it('says written, addressed to the project, and is never stored', async () => {
    const s = await setup()
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ projectId: s.projectId, workItemId: null, personId: null, conversationId: null })
    expect(outcomes()).toEqual([{ week, outcome: 'written' }])
    expect(await typedEvents(s.projectId, 'status.weekly_summary_outcome')).toHaveLength(0)
  })

  it('gives the reason on every skipped run', async () => {
    const noAi = await setup({ noAi: true })
    await runWeeklySummary(deps, { projectId: noAi.projectId, week, force: true })
    const quiet = await setup()
    await db.update(events).set({ createdAt: daysAgo(9) }).where(eq(events.projectId, quiet.projectId))
    await runWeeklySummary(deps, { projectId: quiet.projectId, week, force: true })
    expect(outcomes()).toEqual([
      { week, outcome: 'skipped', reason: 'no_ai' },
      { week, outcome: 'skipped', reason: 'no_activity' },
    ])
  })

  it('reports an exceeded budget on each run while the stored skip stays once per week', async () => {
    const s = await setup({ budget: '1' })
    await db.insert(aiCalls).values({ projectId: s.projectId, job: 'draft', ok: true, costUsd: '2' })
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    await runWeeklySummary(deps, { projectId: s.projectId, week, force: true })
    expect(outcomes()).toEqual([
      { week, outcome: 'skipped', reason: 'budget_exceeded' },
      { week, outcome: 'skipped', reason: 'budget_exceeded' },
    ])
    expect(await typedEvents(s.projectId, 'status.weekly_summary_skipped')).toHaveLength(1)
  })

  it('reports AI not configured, and AI failures', async () => {
    const s = await setup()
    const bare = { ...deps, ai: new AiGateway({ db, bus: new LiveBus(), models: mockModels({ fast: null, ids: { draft: 'anthropic:claude-opus-5-5', fast: null, embed: null } }), config: testConfig() }) }
    await runWeeklySummary(bare, { projectId: s.projectId, week, force: true })
    const broken = new MockLanguageModelV4({
      modelId: 'claude-haiku-5-5',
      doStream: async () => {
        throw new Error('provider down')
      },
    })
    const failing = { ...deps, ai: new AiGateway({ db, bus: new LiveBus(), models: mockModels({ fast: broken }), config: testConfig() }) }
    await runWeeklySummary(failing, { projectId: s.projectId, week, force: true })
    expect(outcomes()).toEqual([
      { week, outcome: 'skipped', reason: 'ai_not_configured' },
      { week, outcome: 'skipped', reason: 'ai_failed' },
    ])
    expect(await weeklyEntries(s.projectId)).toHaveLength(0)
  })
})

describe('summary window', () => {
  const lastWeek = () => summaryWeek(new Date())

  it('the scheduled week reads only that week, not the current one', async () => {
    const s = await setup()
    await db.update(events).set({ createdAt: daysAgo(30) }).where(eq(events.projectId, s.projectId))
    const inLastWeek = new Date(weekStart(lastWeek()).getTime() + 86_400_000)
    await db.insert(events).values({ projectId: s.projectId, workItemId: s.workItemId, type: 'task.started', createdAt: inLastWeek })
    await event(s, 'gitlab.mr_merged', 0)
    await runWeeklySummary(deps, { projectId: s.projectId, week: lastWeek(), force: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('task.started')
    expect(prompts[0]).not.toContain('gitlab.mr_merged')
  })

  it('a regenerate writes the current week and leaves last week untouched', async () => {
    const s = await setup()
    const inLastWeek = new Date(weekStart(lastWeek()).getTime() + 86_400_000)
    await db.insert(events).values({ projectId: s.projectId, workItemId: s.workItemId, type: 'task.started', createdAt: inLastWeek })
    await runWeeklySummary(deps, { projectId: s.projectId, week: lastWeek(), force: false })
    jobs.runWeekly = true
    await queueWeeklyRegenerate(deps, s.projectId)
    await jobs.drain()
    expect(jobs.ids('weekly-summary-project')).toEqual([`${s.projectId}:${isoWeek(new Date())}:force`])
    const rows = await weeklyEntries(s.projectId)
    const refs = rows.map((r) => [r.sourceRef, r.version, r.supersededAt === null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(refs).toEqual([
      [`weekly:${s.projectId}:${lastWeek()}`, 1, true],
      [`weekly:${s.projectId}:${isoWeek(new Date())}`, 1, true],
    ])
    expect(rows.find((r) => r.sourceRef!.endsWith(lastWeek()))!.body).toBe('## ความคืบหน้า\nสรุปรอบที่ 1')
    // The current week's material starts on Monday: last week's event is not in it.
    expect(prompts[1]).not.toContain('task.started')
  })

  it('the status shows the newest finished week, and the regenerated week in progress separately', async () => {
    const s = await setup()
    const thisWeek = isoWeek(new Date())
    const inLastWeek = new Date(weekStart(lastWeek()).getTime() + 86_400_000)
    await db.insert(events).values({ projectId: s.projectId, workItemId: s.workItemId, type: 'task.started', createdAt: inLastWeek })
    const app = await makeApp({ jobs })
    try {
      const boss = await login(app, 'boss')
      const status = async () =>
        (await app.inject({ url: `/projects/${s.projectId}/status`, headers: auth(boss) })).json() as ProjectStatus

      // Monday's run: last week's summary is the one shown, nothing in progress.
      await runWeeklySummary(deps, { projectId: s.projectId, week: lastWeek(), force: false })
      let st = await status()
      expect(st.currentWeek).toBe(thisWeek)
      expect(st.weeklySummary).toMatchObject({ week: lastWeek(), body: '## ความคืบหน้า\nสรุปรอบที่ 1' })
      expect(st.weeklyInProgress).toBeNull()

      // A PM regenerates: this week's draft appears beside it; last week's summary still leads.
      await runWeeklySummary(deps, { projectId: s.projectId, week: thisWeek, force: true })
      st = await status()
      expect(st.weeklySummary).toMatchObject({ week: lastWeek(), body: '## ความคืบหน้า\nสรุปรอบที่ 1' })
      expect(st.weeklyInProgress).toMatchObject({ week: thisWeek, body: '## ความคืบหน้า\nสรุปรอบที่ 2', status: 'draft' })

      // Next week, the formerly in-progress week is the newest finished one.
      const nextWeek = new Date(weekStart(thisWeek).getTime() + 7 * 86_400_000 + 3_600_000)
      const later = await weeklySummaries(db, s.projectId, isoWeek(nextWeek))
      expect(later.latest).toMatchObject({ week: thisWeek })
      expect(later.inProgress).toBeNull()
    } finally {
      await app.close()
    }
  }, 15_000)
})

describe('weekly summary jobs', () => {
  it('the schedule fans out one job per active project, keyed by project and week', async () => {
    const a = await setup()
    const b = await setup()
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.id, b.projectId))
    const c = await setup()
    await jobs.runScheduled('weekly-summary')
    const week = isoWeek(sinceWeek())
    expect(jobs.ids('weekly-summary-project').sort()).toEqual([`${a.projectId}:${week}`, `${c.projectId}:${week}`].sort())
  })

  it('the project job writes the summary for its week', async () => {
    const s = await setup()
    jobs.runWeekly = true
    await jobs.send('weekly-summary-project', { id: `${s.projectId}:2026-W48` })
    await jobs.drain()
    const rows = await weeklyEntries(s.projectId)
    expect(rows.map((r) => r.sourceRef)).toEqual([`weekly:${s.projectId}:2026-W48`])
  })
})

describe('POST /projects/:id/weekly-summary', () => {
  let app: FastifyInstance
  let admin: Who
  let pm: Who
  let dev: Who
  let outsider: Who
  let nurse: Who
  const call = (who: Who, url: string) => app.inject({ method: 'POST', url, headers: auth(who) })

  beforeEach(async () => {
    app = await makeApp({ jobs })
    admin = await login(app, 'boss')
    pm = await login(app, 'pm', { staff: true })
    dev = await login(app, 'dev', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    await app.close()
  })

  it('PM or admin → 202 and a forced job; others are refused', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/projects', headers: auth(admin), payload: { name: 'แล็บ' } })).json() as { id: string }
    for (const [who, roles] of [[pm, ['PM']], [dev, ['DEV']]] as const) {
      await app.inject({ method: 'PUT', url: `/projects/${id}/members/${who.id}`, headers: auth(admin), payload: { roles } })
    }
    const url = `/projects/${id}/weekly-summary`
    expect((await call(dev, url)).statusCode).toBe(403)
    expect((await call(nurse, url)).statusCode).toBe(403)
    expect((await call(outsider, url)).statusCode).toBe(404)
    expect((await call(pm, '/projects/00000000-0000-4000-8000-000000000000/weekly-summary')).statusCode).toBe(404)
    expect(jobs.ids('weekly-summary-project')).toEqual([])

    const res = await call(pm, url)
    expect(res.statusCode).toBe(202)
    expect((await call(admin, url)).statusCode).toBe(202)
    // A regenerate is for the week in progress.
    const week = isoWeek(new Date())
    expect(jobs.ids('weekly-summary-project')).toEqual([`${id}:${week}:force`, `${id}:${week}:force`])
  })
})
