import { Person, PersonPatch } from '@yoda/shared'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { lastAdmin, notFound, requireAdmin, requireStaff } from '../auth/plugin.js'
import { people } from '../db/schema.js'

type PersonRow = typeof people.$inferSelect

export function toPerson(row: PersonRow): Person {
  return Person.parse({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    isAdmin: row.isAdmin,
    // Other people's staff status can't come from a token: use the last one we saw.
    isStaff: row.isAdmin || (row.staffOverride ?? row.lastSeenStaff),
    skills: row.skills,
    staffOverride: row.staffOverride,
  })
}

const IdParams = z.object({ id: z.string().uuid() })

export function peopleRoutes(app: FastifyInstance): void {
  app.get('/people', async (request) => {
    requireStaff(request)
    const rows = await app.deps.db.select().from(people).orderBy(asc(people.displayName))
    return rows.map(toPerson)
  })

  app.patch('/people/:id', async (request) => {
    requireAdmin(request)
    const { id } = IdParams.parse(request.params)
    const patch = PersonPatch.parse(request.body)
    const set: Partial<typeof people.$inferInsert> = {}
    if (patch.skills !== undefined) set.skills = patch.skills
    if (patch.staffOverride !== undefined) set.staffOverride = patch.staffOverride
    if (patch.isAdmin !== undefined) set.isAdmin = patch.isAdmin
    const row = await app.deps.db.transaction(async (tx) => {
      if (patch.isAdmin === false) {
        // Serialize admin demotions so concurrent requests can't both pass the check.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('people:admin-change'))`)
        const [other] = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.isAdmin, true), ne(people.id, id)))
          .limit(1)
        if (!other) {
          const [target] = await tx.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, id))
          if (target?.isAdmin) throw lastAdmin()
        }
      }
      const [r] =
        Object.keys(set).length > 0
          ? await tx.update(people).set(set).where(eq(people.id, id)).returning()
          : await tx.select().from(people).where(eq(people.id, id))
      return r
    })
    if (!row) throw notFound()
    return toPerson(row)
  })
}
