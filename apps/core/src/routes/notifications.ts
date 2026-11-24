import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSignedIn } from '../auth/plugin.js'
import { listNotifications, markRead } from '../notifications/service.js'

const ListQuery = z.object({ unread: z.enum(['true', 'false']).optional() })
const ReadBody = z
  .object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() })
  .refine((b) => b.all === true || (b.ids?.length ?? 0) > 0, { message: 'ids or all required' })

/** Open to requesters too: every route only ever touches the caller's own notifications. */
export function notificationRoutes(app: FastifyInstance): void {
  app.get('/me/notifications', async (request) => {
    requireSignedIn(request)
    const q = ListQuery.parse(request.query)
    return listNotifications(app.deps.db, request.me.id, q.unread === 'true')
  })

  app.post('/me/notifications/read', async (request) => {
    requireSignedIn(request)
    const body = ReadBody.parse(request.body)
    return { updated: await markRead(app.deps.db, request.me.id, body) }
  })
}
