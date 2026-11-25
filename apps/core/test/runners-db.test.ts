import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { latestTemplate } from '../src/workflow/seed.js'
import { agentRuns, discussions, people, projects, runners, tasks, workItems } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: 'k1', username: 'u1', displayName: 'U1' }).returning()
  const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
  const templateId = (await latestTemplate(db, 'software-change'))!.id
  const [wi] = await db.insert(workItems).values({ projectId: proj!.id, title: 'w', templateId, ownerId: p!.id }).returning()
  const [task] = await db
    .insert(tasks)
    .values({ workItemId: wi!.id, projectId: proj!.id, stepKey: 's', templateTaskKey: 't', attempt: 1, type: 'ai', role: 'DEV', executor: 'ai', state: 'open' })
    .returning()
  const [runner] = await db
    .insert(runners)
    .values({
      name: 'box', kind: 'server', ownerId: p!.id, accountType: 'api-key', capabilities: ['code-change'], mode: 'unattended',
      maxConcurrent: 1, tokenHash: 'hash-1', tokenPrefix: 'yoda_rt_abc', createdBy: p!.id,
    })
    .returning()
  return { db, p: p!, proj: proj!, wi: wi!, task: task!, runner: runner! }
}

const lease = () => ({ leaseExpiresAt: new Date(Date.now() + 600_000) })

describe('runner tables', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('allows one running run per task', async () => {
    const { db, task, runner, p } = await seed()
    const v = { taskId: task.id, runnerId: runner.id, ownerId: p.id, state: 'running', ...lease() }
    await db.insert(agentRuns).values(v)
    await expect(db.insert(agentRuns).values(v)).rejects.toThrow()
  })

  it('keeps finished runs next to a running one', async () => {
    const { db, task, runner, p } = await seed()
    const v = { taskId: task.id, runnerId: runner.id, ownerId: p.id, ...lease() }
    await db.insert(agentRuns).values({ ...v, state: 'succeeded', endedAt: new Date() })
    await db.insert(agentRuns).values({ ...v, state: 'running' })
    await expect(db.insert(agentRuns).values({ ...v, state: 'done' })).rejects.toThrow()
  })

  it('checks runner enums and unique token hashes', async () => {
    const { db, p } = await seed()
    const v = {
      name: 'b', kind: 'server', ownerId: p.id, accountType: 'api-key', capabilities: ['code-change'], mode: 'on-demand',
      maxConcurrent: 1, tokenHash: 'hash-2', tokenPrefix: 'yoda_rt_x', createdBy: p.id,
    }
    await expect(db.insert(runners).values({ ...v, kind: 'laptop' })).rejects.toThrow()
    await expect(db.insert(runners).values({ ...v, mode: 'sometimes' })).rejects.toThrow()
    await expect(db.insert(runners).values({ ...v, accountType: 'free' })).rejects.toThrow()
    await expect(db.insert(runners).values({ ...v, capabilities: ['draft-text'] })).rejects.toThrow()
    await expect(db.insert(runners).values({ ...v, maxConcurrent: 5 })).rejects.toThrow()
    await expect(db.insert(runners).values({ ...v, tokenHash: 'hash-1' })).rejects.toThrow()
    await db.insert(runners).values(v)
  })

  it('clears a parked discussion when it is deleted', async () => {
    const { db, task, p, proj, wi } = await seed()
    const [d] = await db.insert(discussions).values({ projectId: proj.id, workItemId: wi.id, taskId: task.id, question: 'q', raisedBy: p.id }).returning()
    await db.update(tasks).set({ parkedDiscussionId: d!.id }).where(sql`${tasks.id} = ${task.id}`)
    await db.delete(discussions).where(sql`${discussions.id} = ${d!.id}`)
    const r = await db.execute(sql`SELECT parked_discussion_id FROM tasks WHERE id = ${task.id}`)
    expect(r[0]!.parked_discussion_id).toBeNull()
  })

  it('keeps one runner_settings row, both off by default', async () => {
    await seed()
    const db = await testDb()
    const r = await db.execute(sql`SELECT count(*)::int AS n, bool_or(paused) AS p, bool_or(allow_personal_unattended) AS a FROM runner_settings`)
    expect(r[0]).toMatchObject({ n: 1, p: false, a: false })
    await expect(db.execute(sql`INSERT INTO runner_settings (id) VALUES (2)`)).rejects.toThrow()
  })
})
