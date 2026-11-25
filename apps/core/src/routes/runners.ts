import { RunnerCreate, RunnerPatch, RunnerSettings } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { emptyPatch, forbidden, invalidState, notFound, notStaff, requireAdmin, requireStaff } from '../auth/plugin.js'
import { people, runners, runnerSettings } from '../db/schema.js'
import { getRunner, listRunners, meFromPerson, revokeRunner, type RunnerRow } from '../runners/records.js'
import { newRunnerToken } from '../runners/tokens.js'

const IdParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({ all: z.string().optional() })
const RunnerSettingsPatch = RunnerSettings.partial()

async function readSettings(app: FastifyInstance): Promise<RunnerSettings> {
  const [row] = await app.deps.db.select().from(runnerSettings).where(eq(runnerSettings.id, 1))
  return { paused: row?.paused ?? false, allowPersonalUnattended: row?.allowPersonalUnattended ?? false }
}

export function runnerRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  /** The runner, if the signed-in staff person owns it or is an admin; otherwise 404. */
  async function ownRunner(request: FastifyRequest): Promise<RunnerRow> {
    const { id } = IdParams.parse(request.params)
    const [row] = await db().select().from(runners).where(eq(runners.id, id))
    if (!row || (row.ownerId !== request.me.id && !request.me.isAdmin)) throw notFound()
    return row
  }

  app.get('/runners', async (request) => {
    requireStaff(request)
    const { all } = ListQuery.parse(request.query)
    if (all === '1' && request.me.isAdmin) return listRunners(db())
    return listRunners(db(), eq(runners.ownerId, request.me.id))
  })

  app.post('/runners', async (request, reply) => {
    requireStaff(request)
    const body = RunnerCreate.parse(request.body)
    const me = request.me
    const ownerId = body.ownerId ?? me.id
    if (!me.isAdmin) {
      // Staff register their own machines; server runners and runners for others are an admin's call.
      if (body.kind !== 'dev-machine' || ownerId !== me.id) throw forbidden()
    } else if (ownerId !== me.id) {
      const [owner] = await db().select().from(people).where(eq(people.id, ownerId))
      if (!owner || !meFromPerson(owner).isStaff) throw notStaff()
    }
    const { token, hash, prefix } = newRunnerToken()
    const [row] = await db()
      .insert(runners)
      .values({
        name: body.name,
        kind: body.kind,
        ownerId,
        accountType: body.accountType,
        capabilities: body.capabilities,
        mode: body.mode,
        maxConcurrent: body.maxConcurrent,
        workingHours: body.workingHours,
        tokenHash: hash,
        tokenPrefix: prefix,
        createdBy: me.id,
      })
      .returning({ id: runners.id })
    // The only response that carries the token.
    return reply.status(201).send({ runner: await getRunner(db(), row!.id), token })
  })

  app.patch('/runners/:id', async (request) => {
    requireStaff(request)
    const row = await ownRunner(request)
    const patch = RunnerPatch.parse(request.body)
    if (Object.keys(patch).length === 0) throw emptyPatch()
    if (row.revokedAt) throw invalidState()
    await db().update(runners).set(patch).where(eq(runners.id, row.id))
    return getRunner(db(), row.id)
  })

  app.delete('/runners/:id', async (request) => {
    requireStaff(request)
    const row = await ownRunner(request)
    await revokeRunner(app.deps, request.me, row.id)
    return getRunner(db(), row.id)
  })

  app.get('/admin/runner-settings', async (request) => {
    requireAdmin(request)
    return readSettings(app)
  })

  app.patch('/admin/runner-settings', async (request) => {
    requireAdmin(request)
    const patch = RunnerSettingsPatch.parse(request.body)
    if (Object.keys(patch).length === 0) throw emptyPatch()
    // Upsert: the migration seeds the row, but never fail if it is missing.
    await db()
      .insert(runnerSettings)
      .values({ id: 1, ...patch })
      .onConflictDoUpdate({ target: runnerSettings.id, set: patch })
    return readSettings(app)
  })
}
