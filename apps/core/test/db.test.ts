import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { people } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

describe('database', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  it('enables vector and pg_trgm extensions', async () => {
    const db = await testDb()
    const rows = await db.execute<{ extname: string }>(sql`select extname from pg_extension`)
    const names = rows.map((r) => r.extname)
    expect(names).toContain('vector')
    expect(names).toContain('pg_trgm')
  })

  it('round-trips Thai text', async () => {
    const db = await testDb()
    await db.insert(people).values({ keycloakSub: 'sub-1', username: 'somchai', displayName: 'สมชาย ใจดี' })
    const [row] = await db.select().from(people)
    expect(row.displayName).toBe('สมชาย ใจดี')
    expect(row.skills).toEqual([])
    expect(row.isAdmin).toBe(false)
  })

  it('rejects duplicate keycloak_sub', async () => {
    const db = await testDb()
    await db.insert(people).values({ keycloakSub: 'dup', username: 'a', displayName: 'A' })
    await expect(
      db.insert(people).values({ keycloakSub: 'dup', username: 'b', displayName: 'B' }),
    ).rejects.toThrow()
  })
})
