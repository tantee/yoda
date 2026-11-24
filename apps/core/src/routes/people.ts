import { Person, PersonPatch } from '@yoda/shared'
import { asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { notFound, requireAdmin, requireStaff } from '../auth/plugin.js'
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
    const db = app.deps.db
    const [row] =
      Object.keys(set).length > 0
        ? await db.update(people).set(set).where(eq(people.id, id)).returning()
        : await db.select().from(people).where(eq(people.id, id))
    if (!row) throw notFound()
    return toPerson(row)
  })
}
