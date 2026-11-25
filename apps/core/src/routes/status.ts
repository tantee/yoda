import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireStaff } from '../auth/plugin.js'
import { getDepartmentStatus, getProjectStatus } from '../status/queries.js'

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
    return getProjectStatus(db(), request.me, id)
  })
}
