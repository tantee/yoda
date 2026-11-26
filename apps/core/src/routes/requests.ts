import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSignedIn } from '../auth/plugin.js'
import { getMyAnswers, getMyRequestDetail, getMyRequests } from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })

/** The requester's views; open to staff too (staff can be requesters). Both only ever return the caller's own rows. */
export function requestRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/me/requests', async (request) => {
    requireSignedIn(request)
    return getMyRequests(db(), request.me)
  })

  /** One of the caller's own requests with its plain-language timeline; 404 for anyone else's (staff too). */
  app.get('/me/requests/:id', async (request) => {
    requireSignedIn(request)
    const { id } = IdParams.parse(request.params)
    return getMyRequestDetail(db(), request.me, id)
  })

  app.get('/me/answers', async (request) => {
    requireSignedIn(request)
    return getMyAnswers(db(), request.me)
  })
}
