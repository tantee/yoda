import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { forbidden, notFound, requireStaff } from '../auth/plugin.js'
import { projects } from '../db/schema.js'
import { canManageProject } from '../projects/access.js'
import { getDepartmentStatus, getProjectStatus } from '../status/queries.js'
import { queueWeeklyRegenerate } from '../status/weekly.js'
import { canSeeProject } from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })

/** Staff only: requesters never see health, load or AI spend. */
export function statusRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/status', async (request) => {
    requireStaff(request)
    return getDepartmentStatus(db(), request.me)
  })

  app.get('/projects/:id/status', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    return getProjectStatus(db(), request.me, id, { aiConfigured: app.deps.ai.available('fast') })
  })

  /** PM or admin: regenerate the latest weekly summary (queued; the job replaces it as a new version). */
  app.post('/projects/:id/weekly-summary', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const [project] = await db().select({ id: projects.id }).from(projects).where(eq(projects.id, id))
    if (!project || !(await canSeeProject(db(), request.me, id))) throw notFound()
    if (!(await canManageProject(db(), request.me, id))) throw forbidden()
    await queueWeeklyRegenerate(app.deps, id)
    return reply.code(202).send({ queued: true })
  })
}
