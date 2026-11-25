import {
  DiscussionBriefEdit,
  DiscussionCreate,
  DiscussionDecide,
  DiscussionResponseCreate,
  DiscussionState,
  DiscussionWithdraw,
} from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireStaff } from '../auth/plugin.js'
import { getDiscussion, listDiscussions, listResponses } from '../discussions/queries.js'
import { createDiscussion, decideDiscussion, editBrief, respond, withdrawDiscussion } from '../discussions/service.js'
import { runWork } from '../work/context.js'

const IdParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({
  state: DiscussionState.optional(),
  projectId: z.string().uuid().optional(),
  sort: z.enum(['priority', 'created', 'project']).optional(),
})

/** Staff only: requesters get 403 on every route, before any lookup. */
export function discussionRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db
  const asPerson = (id: string) => ({ id, kind: 'person' as const })

  app.get('/discussions', async (request) => {
    requireStaff(request)
    return listDiscussions(db(), request.me, ListQuery.parse(request.query))
  })

  app.post('/discussions', async (request, reply) => {
    requireStaff(request)
    const body = DiscussionCreate.parse(request.body)
    const me = request.me
    const id = await runWork(app.deps, asPerson(me.id), (ctx) => createDiscussion(ctx, me, body))
    return reply.status(201).send(await getDiscussion(db(), me, id))
  })

  app.get('/discussions/:id', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    return getDiscussion(db(), request.me, id)
  })

  app.get('/discussions/:id/responses', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    return listResponses(db(), request.me, id)
  })

  app.post('/discussions/:id/responses', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = DiscussionResponseCreate.parse(request.body)
    const me = request.me
    return runWork(app.deps, asPerson(me.id), (ctx) => respond(ctx, me, id, body))
  })

  app.put('/discussions/:id/brief', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = DiscussionBriefEdit.parse(request.body)
    const me = request.me
    await runWork(app.deps, asPerson(me.id), (ctx) => editBrief(ctx, me, id, body))
    return getDiscussion(db(), me, id)
  })

  app.post('/discussions/:id/decide', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = DiscussionDecide.parse(request.body)
    const me = request.me
    await runWork(app.deps, asPerson(me.id), (ctx) => decideDiscussion(ctx, me, id, body))
    return getDiscussion(db(), me, id)
  })

  app.post('/discussions/:id/withdraw', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = DiscussionWithdraw.parse(request.body)
    const me = request.me
    await runWork(app.deps, asPerson(me.id), (ctx) => withdrawDiscussion(ctx, me, id, body))
    return getDiscussion(db(), me, id)
  })
}
