import { SearchQuery } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { requireSignedIn } from '../auth/plugin.js'
import { requesterCounts, staffCounts } from '../shell/counts.js'
import { search } from '../shell/search.js'

/** The portal shell: rail badges and the jump box. Open to requesters, who only ever get their own rows. */
export function shellRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/me/counts', async (request) => {
    requireSignedIn(request)
    return request.me.isStaff ? staffCounts(db(), request.me) : requesterCounts(db(), request.me)
  })

  app.get('/search', async (request) => {
    requireSignedIn(request)
    const { q } = SearchQuery.parse(request.query)
    return search(db(), request.me, q)
  })
}
