import { beforeEach, describe, expect, it } from 'vitest'
import { asc, eq, sql } from 'drizzle-orm'
import type { LiveEvent, TemplateTask } from '@yoda/shared'
import type { Db } from '../src/db/client.js'
import { events, people, projectMembers, projects, tasks, workItems } from '../src/db/schema.js'
import { LiveBus } from '../src/live/bus.js'
import { recordEvent, runWork } from '../src/work/context.js'
import { InlineJobQueue, type JobName } from '../src/jobs/queue.js'
import { pickAssignee } from '../src/work/assign.js'
import { createTaskAttempt } from '../src/work/tasks.js'
import { latestTemplate } from '../src/workflow/seed.js'
import { resetDb, testDb } from './helpers.js'

const taskDef: TemplateTask = {
  key: 'implement',
  type: 'human',
  role: 'DEV',
  title: { th: 'ทำ', en: 'Implement' },
  instructions: { th: 'x', en: 'x' },
  dependsOn: [],
}

async function person(db: Db, name: string) {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name })
    .returning()
  return p!.id
}

async function setup(db: Db, autonomy: 'propose' | 'auto-assign' = 'propose') {
  const owner = await person(db, 'owner')
  const [proj] = await db.insert(projects).values({ name: 'P', autonomy, createdBy: owner }).returning()
  const tpl = (await latestTemplate(db, 'software-change'))!
  const [wi] = await db
    .insert(workItems)
    .values({ projectId: proj!.id, templateId: tpl.id, title: 'W', ownerId: owner })
    .returning()
  return { projectId: proj!.id, workItemId: wi!.id, owner }
}

const member = (db: Db, projectId: string, personId: string, roles: string[]) =>
  db.insert(projectMembers).values({ projectId, personId, roles })

const input = (s: { projectId: string; workItemId: string }, over: Record<string, unknown> = {}) => ({
  workItemId: s.workItemId,
  projectId: s.projectId,
  stepKey: 'build',
  task: taskDef,
  attempt: 1,
  feedback: null,
  assigneeHint: null,
  executor: 'human' as const,
  ...over,
})

async function taskEvents(db: Db, taskId: string) {
  return db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq))
}

describe('pickAssignee', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('picks lowest load, ties by display name, null when none, ignores non-members', async () => {
    const db = await testDb()
    const s = await setup(db)
    const bob = await person(db, 'Bob')
    const amy = await person(db, 'Amy')
    const outsider = await person(db, 'Aaa')
    await member(db, s.projectId, bob, ['DEV'])
    await member(db, s.projectId, amy, ['DEV'])
    expect(await db.transaction((tx) => pickAssignee(tx, s.projectId, 'DEV'))).toBe(amy)

    await db.insert(tasks).values({
      workItemId: s.workItemId, projectId: s.projectId, stepKey: 'a', templateTaskKey: 'k1', attempt: 1,
      type: 'human', role: 'DEV', executor: 'human', state: 'open', assigneeId: amy,
    })
    expect(await db.transaction((tx) => pickAssignee(tx, s.projectId, 'DEV'))).toBe(bob)

    // proposed counts toward the proposed assignee; done does not
    await db.insert(tasks).values([
      { workItemId: s.workItemId, projectId: s.projectId, stepKey: 'a', templateTaskKey: 'k2', attempt: 1,
        type: 'human', role: 'DEV', executor: 'human', state: 'proposed', proposedAssigneeId: bob },
      { workItemId: s.workItemId, projectId: s.projectId, stepKey: 'a', templateTaskKey: 'k3', attempt: 1,
        type: 'human', role: 'DEV', executor: 'human', state: 'accepted', assigneeId: amy },
    ])
    expect(await db.transaction((tx) => pickAssignee(tx, s.projectId, 'DEV'))).toBe(amy)

    expect(await db.transaction((tx) => pickAssignee(tx, s.projectId, 'QC'))).toBeNull()
    void outsider
    expect(await db.transaction((tx) => pickAssignee(tx, s.projectId, 'BA'))).toBeNull()
  })
})

describe('pickAssignee daily cap', () => {
  beforeEach(async () => resetDb(await testDb()))

  const autoAssigned = (db: Db, projectId: string, assigneeId: string, n: number, over: { createdAt?: Date; payload?: Record<string, unknown> } = {}) =>
    db.insert(events).values(
      Array.from({ length: n }, () => ({
        projectId,
        type: 'task.assigned',
        actorKind: 'system',
        payload: { assigneeId, auto: true, ...over.payload },
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      })),
    )

  it('skips people at the cap today (Asia/Bangkok), counting only automatic assignments', async () => {
    const db = await testDb()
    const s = await setup(db)
    const amy = await person(db, 'Amy')
    const bob = await person(db, 'Bob')
    await member(db, s.projectId, amy, ['DEV'])
    await member(db, s.projectId, bob, ['DEV'])
    const pick = (cap?: number) => db.transaction((tx) => pickAssignee(tx, s.projectId, 'DEV', { cap }))

    const [{ start }] = (await db.execute(
      sql`select (date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok') as start`,
    )) as unknown as { start: Date }[]
    const dayStart = new Date(start)
    // Yesterday's, manual (no auto marker) and other people's assignments do not count.
    await autoAssigned(db, s.projectId, amy, 5, { createdAt: new Date(dayStart.getTime() - 1000) })
    await autoAssigned(db, s.projectId, amy, 5, { payload: { auto: false } })
    await autoAssigned(db, s.projectId, bob, 1)
    expect(await pick(2)).toBe(amy)
    // Exactly at midnight counts as today.
    await autoAssigned(db, s.projectId, amy, 2, { createdAt: dayStart })
    expect(await pick(2)).toBe(bob)
    await autoAssigned(db, s.projectId, bob, 1)
    expect(await pick(2)).toBeNull()
    // Without a cap (manual flows, proposals) everyone stays eligible.
    expect(await pick()).toBe(amy)
  })
})

describe('createTaskAttempt', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('propose project -> proposed', async () => {
    const db = await testDb()
    const s = await setup(db, 'propose')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: s.owner, kind: 'person' }, (ctx) => createTaskAttempt(ctx, input(s)))
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'proposed', proposedAssigneeId: dev, assigneeId: null, role: 'DEV', type: 'human' })
    expect((await taskEvents(db, id)).map((e) => e.type)).toEqual(['task.created', 'task.proposed'])
  })

  it('auto-assign project -> open with assignee', async () => {
    const db = await testDb()
    const s = await setup(db, 'auto-assign')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, (ctx) => createTaskAttempt(ctx, input(s)))
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'open', assigneeId: dev, proposedAssigneeId: null })
    expect((await taskEvents(db, id)).map((e) => e.type)).toEqual(['task.created', 'task.assigned'])
  })

  it('assigneeHint is assigned directly', async () => {
    const db = await testDb()
    const s = await setup(db, 'propose')
    const hint = await person(db, 'Hint')
    await member(db, s.projectId, hint, ['BA'])
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, (ctx) =>
      createTaskAttempt(ctx, input(s, { assigneeHint: hint, attempt: 2, feedback: 'redo' })),
    )
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'open', assigneeId: hint, attempt: 2, feedback: 'redo' })
    expect((await taskEvents(db, id)).map((e) => e.type)).toEqual(['task.created', 'task.assigned'])
  })

  it('assigneeHint who left the project falls back to the candidate flow', async () => {
    const db = await testDb()
    const s = await setup(db, 'propose')
    const gone = await person(db, 'Gone')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, (ctx) =>
      createTaskAttempt(ctx, input(s, { assigneeHint: gone, attempt: 2 })),
    )
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'proposed', assigneeId: null, proposedAssigneeId: dev })
  })

  it('ai executor -> open, no assignee', async () => {
    const db = await testDb()
    const s = await setup(db, 'auto-assign')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, (ctx) =>
      createTaskAttempt(ctx, input(s, { executor: 'ai' })),
    )
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null, executor: 'ai' })
    expect((await taskEvents(db, id)).map((e) => e.type)).toEqual(['task.created'])
  })

  it('auto-assign marks the event auto and stops at the configured cap with reason daily_cap', async () => {
    const db = await testDb()
    const s = await setup(db, 'auto-assign')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const deps = { db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 2 } }
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await runWork(deps, { id: null, kind: 'system' }, (ctx) => createTaskAttempt(ctx, input(s, { task: { ...taskDef, key: `k${i}` } }))))
    }
    const [a, b, c] = await Promise.all(ids.map((id) => taskEvents(db, id)))
    expect(a!.find((e) => e.type === 'task.assigned')!.payload).toEqual({ assigneeId: dev, auto: true })
    expect(b!.map((e) => e.type)).toEqual(['task.created', 'task.assigned'])
    expect(c!.map((e) => e.type)).toEqual(['task.created'])
    expect(c![0]!.reason).toBe('daily_cap')
    const [t] = await db.select().from(tasks).where(eq(tasks.id, ids[2]!))
    expect(t).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
  })

  it('propose projects are not capped (a proposal is not an assignment)', async () => {
    const db = await testDb()
    const s = await setup(db, 'propose')
    const dev = await person(db, 'Dev')
    await member(db, s.projectId, dev, ['DEV'])
    const deps = { db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 1 } }
    for (let i = 0; i < 3; i++) {
      const id = await runWork(deps, { id: null, kind: 'system' }, (ctx) => createTaskAttempt(ctx, input(s, { task: { ...taskDef, key: `k${i}` } })))
      const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
      expect(t).toMatchObject({ state: 'proposed', proposedAssigneeId: dev })
    }
  })

  it('no candidate -> open unassigned with reason', async () => {
    const db = await testDb()
    const s = await setup(db, 'propose')
    const id = await runWork({ db, bus: new LiveBus(), jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, (ctx) => createTaskAttempt(ctx, input(s)))
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
    expect(t).toMatchObject({ state: 'open', assigneeId: null, proposedAssigneeId: null })
    const evs = await taskEvents(db, id)
    expect(evs.map((e) => e.type)).toEqual(['task.created'])
    expect(evs[0]!.reason).toBe('no_candidate')
  })
})

describe('runWork', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('publishes only after commit', async () => {
    const db = await testDb()
    const s = await setup(db)
    const bus = new LiveBus()
    const seen: { e: LiveEvent; count: number }[] = []
    bus.subscribe(async (e) => {
      const rows = await db.select().from(events)
      seen.push({ e, count: rows.length })
    })
    await runWork({ db, bus, jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: s.owner, kind: 'person' }, async (ctx) => {
      await recordEvent(ctx, { type: 'work_item.created', projectId: s.projectId, workItemId: s.workItemId, taskId: null })
      expect(seen).toHaveLength(0)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.count).toBe(1)
    expect(seen[0]!.e).toEqual({
      type: 'work_item.created', projectId: s.projectId, workItemId: s.workItemId, taskId: null, conversationId: null, personId: null,
    })
    const [row] = await db.select().from(events)
    expect(row!.actorId).toBe(s.owner)
  })

  it('sends queued jobs only after commit, and none on rollback', async () => {
    const db = await testDb()
    const s = await setup(db)
    const sent: { name: string; id: string; eventsAtSend: number }[] = []
    const jobs = {
      send: async (name: JobName, data: { id: string }) => {
        sent.push({ name, id: data.id, eventsAtSend: (await db.select().from(events)).length })
      },
    }
    await runWork({ db, bus: new LiveBus(), jobs, config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, async (ctx) => {
      await recordEvent(ctx, { type: 'work_item.created', projectId: s.projectId, workItemId: s.workItemId, taskId: null })
      ctx.jobs.push({ name: 'embed-entry', id: 'e1' })
      expect(sent).toHaveLength(0)
    })
    expect(sent).toEqual([{ name: 'embed-entry', id: 'e1', eventsAtSend: 1 }])

    await expect(
      runWork({ db, bus: new LiveBus(), jobs, config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, async (ctx) => {
        ctx.jobs.push({ name: 'draft-task', id: 't1' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(sent).toHaveLength(1)
  })

  it('publishes nothing and rolls back when fn throws; listener errors do not reach publisher', async () => {
    const db = await testDb()
    const s = await setup(db)
    const bus = new LiveBus()
    const seen: LiveEvent[] = []
    bus.subscribe((e) => void seen.push(e))
    await expect(
      runWork({ db, bus, jobs: new InlineJobQueue(), config: { dailyTaskCap: 8 } }, { id: null, kind: 'system' }, async (ctx) => {
        await recordEvent(ctx, { type: 'work_item.created', projectId: s.projectId, workItemId: s.workItemId, taskId: null })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(seen).toHaveLength(0)
    expect(await db.select().from(events)).toHaveLength(0)

    const bus2 = new LiveBus()
    const err = console.error
    const logged: unknown[][] = []
    console.error = (...a: unknown[]) => void logged.push(a)
    try {
      bus2.subscribe(async () => { throw new Error('async bad') })
      bus2.subscribe(() => { throw new Error('bad listener') })
      expect(() => bus2.publish({ type: 'task.created', projectId: s.projectId, workItemId: null, taskId: null, conversationId: null, personId: null })).not.toThrow()
      await new Promise((r) => setTimeout(r, 20))
      expect(logged.length).toBeGreaterThanOrEqual(2)
    } finally {
      console.error = err
    }
  })
})
