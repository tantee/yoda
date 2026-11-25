import { beforeEach, describe, expect, it } from 'vitest'
import { discussionResponses, discussions, people } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: 'k1', username: 'u1', displayName: 'U1' }).returning()
  const [d] = await db.insert(discussions).values({ question: 'q', raisedBy: p!.id }).returning()
  return { db, p: p!, d: d! }
}

describe('discussion tables', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('allows only one vote per person but many opinions', async () => {
    const { db, p, d } = await seed()
    const base = { discussionId: d.id, authorId: p.id }
    await db.insert(discussionResponses).values({ ...base, kind: 'vote', optionKey: 'a' })
    await expect(db.insert(discussionResponses).values({ ...base, kind: 'vote', optionKey: 'b' })).rejects.toThrow()
    await db.insert(discussionResponses).values([{ ...base, kind: 'opinion', text: 'x' }, { ...base, kind: 'opinion', text: 'y' }])
  })

  it('rejects an unknown state', async () => {
    const { db, p } = await seed()
    await expect(db.insert(discussions).values({ question: 'q', raisedBy: p.id, state: 'closed' })).rejects.toThrow()
  })
})
