import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { events, knowledgeChunks, knowledgeEntries, people, projects } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: randomUUID(), username: 'u', displayName: 'U' }).returning()
  const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
  return { db, person: p!, project: proj! }
}

const entry = (over: Partial<typeof knowledgeEntries.$inferInsert> = {}) => ({
  lineageId: randomUUID(),
  version: 1,
  scope: 'department',
  type: 'fact',
  title: 'หัวข้อ',
  status: 'confirmed',
  sourceKind: 'person',
  ...over,
})

describe('knowledge tables', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  it('rejects two live versions of one lineage, allows a superseded one', async () => {
    const { db } = await seed()
    const lineageId = randomUUID()
    await db.insert(knowledgeEntries).values(entry({ lineageId }))
    await expect(db.insert(knowledgeEntries).values(entry({ lineageId, version: 2 }))).rejects.toThrow()
    await db.insert(knowledgeEntries).values(entry({ lineageId, version: 3, supersededAt: new Date() }))
  })

  it('enforces scope/id consistency', async () => {
    const { db, project } = await seed()
    await expect(db.insert(knowledgeEntries).values(entry({ scope: 'project' }))).rejects.toThrow()
    await expect(db.insert(knowledgeEntries).values(entry({ scope: 'department', projectId: project.id }))).rejects.toThrow()
    await expect(db.insert(knowledgeEntries).values(entry({ scope: 'work_item', projectId: project.id }))).rejects.toThrow()
    await db.insert(knowledgeEntries).values(entry({ scope: 'project', projectId: project.id }))
  })

  it('stores 1024-dim embeddings only', async () => {
    const { db } = await seed()
    const [e] = await db.insert(knowledgeEntries).values(entry()).returning()
    await db.insert(knowledgeChunks).values({ entryId: e!.id, idx: 0, text: 't', embedding: Array(1024).fill(0.1) })
    await expect(
      db.insert(knowledgeChunks).values({ entryId: e!.id, idx: 1, text: 't', embedding: [1, 2, 3] }),
    ).rejects.toThrow()
  })

  it('events.actor_kind defaults to person', async () => {
    const { db, project } = await seed()
    const [ev] = await db.insert(events).values({ projectId: project.id, type: 'x' }).returning()
    expect(ev!.actorKind).toBe('person')
  })

  it('has the HNSW and trigram indexes', async () => {
    const db = await testDb()
    const rows = (await db.execute(
      sql`select indexdef from pg_indexes where tablename in ('knowledge_chunks','knowledge_entries')`,
    )) as unknown as { indexdef: string }[]
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/hnsw.*vector_cosine_ops/)
    expect(defs).toMatch(/gin_trgm_ops/)
  })
})
