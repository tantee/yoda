import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { threadAudience } from '../src/chat/audience.js'
import { conversations, people, projects, workItems, workflowTemplates } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: randomUUID(), username: 'u', displayName: 'U' }).returning()
  const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
  const [tpl] = await db.select().from(workflowTemplates).limit(1)
  const item = (requesterId: string | null) =>
    db.insert(workItems).values({ projectId: proj!.id, templateId: tpl!.id, title: 'W', ownerId: p!.id, requesterId }).returning().then((r) => r[0]!)
  return { db, p: p!, proj: proj!, item }
}

describe('threadAudience', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  it('personal and intake threads are own', async () => {
    const { db, p } = await seed()
    for (const kind of ['personal', 'intake'] as const) {
      const [c] = await db.insert(conversations).values({ kind, ownerId: p.id, title: 't' }).returning()
      expect(await threadAudience(db, c!)).toEqual({ kind, own: true, team: false, projectId: null, workItemId: null, requesterVisible: false, requesterId: null, hideStaffNames: false })
    }
  })

  it('project threads are team, staff only', async () => {
    const { db, p, proj } = await seed()
    const [c] = await db.insert(conversations).values({ kind: 'project', ownerId: p.id, projectId: proj.id, title: 't' }).returning()
    expect(await threadAudience(db, c!)).toEqual({ kind: 'project', own: false, team: true, projectId: proj.id, workItemId: null, requesterVisible: false, requesterId: null, hideStaffNames: false })
  })

  it('work_item threads hide staff names; requesterVisible follows the requester', async () => {
    const { db, p, proj, item } = await seed()
    const without = await item(null)
    const [c1] = await db.insert(conversations).values({ kind: 'work_item', ownerId: p.id, projectId: proj.id, workItemId: without.id, title: 't' }).returning()
    expect(await threadAudience(db, c1!)).toEqual({ kind: 'work_item', own: false, team: true, projectId: proj.id, workItemId: without.id, requesterVisible: false, requesterId: null, hideStaffNames: true })
    const withReq = await item(p.id)
    const [c2] = await db.insert(conversations).values({ kind: 'work_item', ownerId: p.id, projectId: proj.id, workItemId: withReq.id, title: 't' }).returning()
    expect(await threadAudience(db, c2!)).toMatchObject({ requesterVisible: true, hideStaffNames: true, workItemId: withReq.id })
  })
})

describe('threadAudience edge cases', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  it('a work_item conversation without a work item has no requester', async () => {
    const { db, p, proj } = await seed()
    // The table forbids this row, so the audience of a hand-built one is checked.
    const c = { id: randomUUID(), kind: 'work_item', ownerId: p.id, projectId: proj.id, workItemId: null, title: 't', createdAt: new Date(), lastMessageAt: null }
    expect(await threadAudience(db, c)).toMatchObject({ team: true, workItemId: null, requesterVisible: false, requesterId: null, hideStaffNames: true })
  })

  it('re-reads the requester each call', async () => {
    const { db, p, proj, item } = await seed()
    const w = await item(null)
    const [c] = await db.insert(conversations).values({ kind: 'work_item', ownerId: p.id, projectId: proj.id, workItemId: w.id, title: 't' }).returning()
    expect(await threadAudience(db, c!)).toMatchObject({ requesterVisible: false, requesterId: null })
    await db.update(workItems).set({ requesterId: p.id }).where(eq(workItems.id, w.id))
    expect(await threadAudience(db, c!)).toMatchObject({ requesterVisible: true, requesterId: p.id })
    await db.update(workItems).set({ requesterId: null }).where(eq(workItems.id, w.id))
    expect(await threadAudience(db, c!)).toMatchObject({ requesterVisible: false, requesterId: null })
  })
})
