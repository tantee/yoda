import type { FastifyInstance } from 'fastify'
import { requireSignedIn } from '../auth/plugin.js'
import { getMyAnswers, getMyRequests } from '../work/queries.js'

/** The requester's views; open to staff too (staff can be requesters). Both only ever return the caller's own rows. */
export function requestRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/me/requests', async (request) => {
    requireSignedIn(request)
    return getMyRequests(db(), request.me)
  })

  app.get('/me/answers', async (request) => {
    requireSignedIn(request)
    return getMyAnswers(db(), request.me)
  })
}
