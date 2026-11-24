import { AiUsage } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { notFound, requireStaff } from '../auth/plugin.js'
import { monthUsage } from '../ai/gateway.js'
import { projectMembers, projects } from '../db/schema.js'

export function aiRoutes(app: FastifyInstance): void {
  app.get('/projects/:id/ai-usage', async (request) => {
    requireStaff(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const db = app.deps.db
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id))
    if (!p) throw notFound()
    if (!request.me.isAdmin) {
      const [m] = await db
        .select({ id: projectMembers.personId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.personId, request.me.id)))
      if (!m) throw notFound()
    }
    return AiUsage.parse(await monthUsage(db, id))
  })
}
