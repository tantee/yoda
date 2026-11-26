import { KnowledgeCreate, KnowledgeStatus, KnowledgeType, KnowledgeUpdate } from '@yoda/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { notFound, requireStaff } from '../auth/plugin.js'
import { searchKnowledge } from '../knowledge/search.js'
import {
  confirmEntry,
  countEntries,
  createEntry,
  getEntry,
  listEntries,
  listVersions,
  updateEntry,
  workItemProject,
} from '../knowledge/service.js'
import { runWork } from '../work/context.js'
import { canSeeProject } from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })
const ScopeQuery = z.object({ projectId: z.string().uuid().optional(), workItemId: z.string().uuid().optional() })
const ListQuery = ScopeQuery.extend({
  type: KnowledgeType.optional(),
  status: KnowledgeStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})
const SearchQuery = ScopeQuery.extend({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

export function knowledgeRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  /** 404 unless the filtered project / work item is visible. */
  async function checkScope(request: FastifyRequest, q: z.infer<typeof ScopeQuery>): Promise<void> {
    const me = request.me
    if (q.workItemId) {
      const p = await workItemProject(db(), q.workItemId)
      if (!p || (q.projectId && q.projectId !== p) || !(await canSeeProject(db(), me, p))) throw notFound()
    }
    if (q.projectId && !(await canSeeProject(db(), me, q.projectId))) throw notFound()
  }

  async function entryOr404(request: FastifyRequest, id: string) {
    const e = await getEntry(db(), request.me, id)
    if (!e) throw notFound()
    return e
  }

  /**
   * Newest first. With `limit` (1-200, default 200) or `offset` the list is a page and `x-total-count` gives the
   * matching total; without them there is no count query.
   */
  app.get('/knowledge', async (request, reply) => {
    requireStaff(request)
    const q = ListQuery.parse(request.query)
    await checkScope(request, q)
    if (q.limit === undefined && q.offset === undefined) return listEntries(db(), request.me, q)
    const [entries, total] = await Promise.all([listEntries(db(), request.me, q), countEntries(db(), request.me, q)])
    reply.header('x-total-count', String(total))
    return entries
  })

  app.get('/knowledge/search', async (request) => {
    requireStaff(request)
    const q = SearchQuery.parse(request.query)
    await checkScope(request, q)
    return searchKnowledge(
      db(),
      request.me,
      { query: q.q, projectId: q.projectId, workItemId: q.workItemId, limit: q.limit },
      app.deps.ai,
    )
  })

  app.get('/knowledge/:id', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    return entryOr404(request, id)
  })

  app.get('/knowledge/:id/versions', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const versions = await listVersions(db(), request.me, id)
    if (!versions) throw notFound()
    return versions
  })

  app.post('/knowledge', async (request, reply) => {
    requireStaff(request)
    const body = KnowledgeCreate.parse(request.body)
    const me = request.me
    const id = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) => createEntry(ctx, me, { ...body, sourceKind: 'person' }))
    return reply.status(201).send(await entryOr404(request, id))
  })

  app.patch('/knowledge/:id', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const patch = KnowledgeUpdate.parse(request.body)
    const me = request.me
    const newId = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) => updateEntry(ctx, me, id, patch))
    return entryOr404(request, newId)
  })

  app.post('/knowledge/:id/confirm', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const me = request.me
    const newId = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) => confirmEntry(ctx, me, id))
    return entryOr404(request, newId)
  })
}
