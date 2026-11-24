import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { people, projects, tasks, workItems } from '../src/db/schema.js'
import { latestTemplate, seedTemplates } from '../src/workflow/seed.js'
import { resetDb, testDb } from './helpers.js'

const tplDir = new URL('../src/workflow/templates/', import.meta.url)

function tempDirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content))
  return dir
}
const sc = () => JSON.parse(readFileSync(new URL('software-change.json', tplDir), 'utf8'))

describe('template seeding', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('seeds version 1 and is idempotent', async () => {
    const db = await testDb()
    expect((await latestTemplate(db, 'software-change'))?.version).toBe(1)
    await seedTemplates(db)
    expect((await latestTemplate(db, 'software-change'))?.version).toBe(1)
    expect(await latestTemplate(db, 'nope')).toBeNull()
  })

  it('adds a new version when the definition changes', async () => {
    const db = await testDb()
    const def = sc()
    def.name.en = 'Software change v2'
    await seedTemplates(db, tempDirWith({ 'software-change.json': def }))
    const latest = await latestTemplate(db, 'software-change')
    expect(latest?.version).toBe(2)
    expect(latest?.definition.name.en).toBe('Software change v2')
  })

  it('throws listing problems for an invalid template', async () => {
    const db = await testDb()
    const def = sc()
    def.steps = []
    await expect(seedTemplates(db, tempDirWith({ 'bad.json': def }))).rejects.toThrow(/bad\.json/)
  })
})

describe('tasks constraints', () => {
  beforeEach(async () => resetDb(await testDb()))

  async function setup() {
    const db = await testDb()
    const [p] = await db.insert(people).values({ keycloakSub: 's', username: 'u', displayName: 'U' }).returning()
    const [pr] = await db.insert(projects).values({ name: 'P' }).returning()
    const tpl = (await latestTemplate(db, 'software-change'))!
    const [wi] = await db
      .insert(workItems)
      .values({ projectId: pr!.id, templateId: tpl.id, title: 'W', ownerId: p!.id })
      .returning()
    const base = {
      workItemId: wi!.id,
      projectId: pr!.id,
      stepKey: 's',
      templateTaskKey: 't',
      type: 'human',
      role: 'DEV',
      executor: 'human',
    }
    return { db, base }
  }

  it('rejects two active attempts of the same task', async () => {
    const { db, base } = await setup()
    await db.insert(tasks).values({ ...base, attempt: 1, state: 'open' })
    await expect(db.insert(tasks).values({ ...base, attempt: 2, state: 'open' })).rejects.toThrow()
  })

  it('allows a new attempt after the previous was accepted', async () => {
    const { db, base } = await setup()
    await db.insert(tasks).values({ ...base, attempt: 1, state: 'accepted' })
    await db.insert(tasks).values({ ...base, attempt: 2, state: 'open' })
    expect(await db.select().from(tasks).where(eq(tasks.workItemId, base.workItemId))).toHaveLength(2)
  })

  it('rejects an invalid role', async () => {
    const { db, base } = await setup()
    await expect(db.insert(tasks).values({ ...base, role: 'CEO', attempt: 1, state: 'open' })).rejects.toThrow()
  })
})
