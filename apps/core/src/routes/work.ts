import { TaskAssign, TaskResult, WorkItemCreate, type Me } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { notFound, requireSignedIn, requireStaff } from '../auth/plugin.js'
import { runWork, type WorkCtx } from '../work/context.js'
import {
  assignTask,
  cancelWorkItem,
  confirmTask,
  createWorkItem,
  retryAiTask,
  startTask,
  submitTask,
} from '../work/engine.js'
import {
  getTask,
  getTodo,
  getWorkItemDetail,
  listTemplates,
  listWorkItems,
  requireTaskVisible,
  requireWorkItemVisible,
} from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })

export function workRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/workflow-templates', async (request) => {
    requireStaff(request)
    return listTemplates(db())
  })

  app.get('/projects/:id/work-items', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    return listWorkItems(db(), request.me, id)
  })

  app.post('/projects/:id/work-items', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = WorkItemCreate.parse(request.body)
    const me = request.me
    // createWorkItem answers 404 for non-members and unknown projects.
    const workItemId = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) => createWorkItem(ctx, me, id, body))
    return reply.status(201).send(await getWorkItemDetail(db(), me, workItemId))
  })

  app.get('/work-items/:id', async (request) => {
    // Requesters follow their requests through /me/requests; here they get the same 404 as an unknown id.
    if (!request.me.isStaff) throw notFound()
    const { id } = IdParams.parse(request.params)
    return getWorkItemDetail(db(), request.me, id)
  })

  app.post('/work-items/:id/cancel', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const me = request.me
    await runWork(app.deps, { id: me.id, kind: 'person' }, async (ctx) => {
      await requireWorkItemVisible(ctx.tx, me, id)
      await cancelWorkItem(ctx, me, id)
    })
    return getWorkItemDetail(db(), me, id)
  })

  app.get('/me/todo', async (request) => {
    requireStaff(request)
    return getTodo(db(), request.me)
  })

  // Staff, or anyone for a REQUESTER task assigned to them (getTask applies the same rule, 404 otherwise).
  app.get('/tasks/:id', async (request) => {
    requireSignedIn(request)
    const { id } = IdParams.parse(request.params)
    return getTask(db(), request.me, id)
  })

  /**
   * Task mutations. The body is validated first; then, inside the transaction, non-members get 404
   * (not 403) so task ids are never confirmed to exist. Returns the fresh task.
   * `requesterTask` routes also accept a REQUESTER task assigned to the caller (requesters included);
   * the rest are staff-only and refuse requesters before any lookup.
   */
  const taskAction = <B>(
    path: string,
    access: 'staff' | 'requesterTask',
    parse: (body: unknown) => B,
    act: (ctx: WorkCtx, me: Me, id: string, body: B) => Promise<void>,
  ) =>
    app.post(`/tasks/:id/${path}`, async (request) => {
      if (access === 'staff') requireStaff(request)
      else requireSignedIn(request)
      const { id } = IdParams.parse(request.params)
      const body = parse(request.body)
      const me = request.me
      await runWork(app.deps, { id: me.id, kind: 'person' }, async (ctx) => {
        await requireTaskVisible(ctx.tx, me, id, { requesterTask: access === 'requesterTask' })
        await act(ctx, me, id, body)
      })
      return getTask(db(), me, id)
    })

  const none = () => undefined
  taskAction('start', 'requesterTask', none, (ctx, me, id) => startTask(ctx, me, id))
  taskAction('submit', 'requesterTask', (b) => TaskResult.parse(b ?? {}), (ctx, me, id, result) => submitTask(ctx, me, id, result))
  taskAction('confirm', 'staff', none, (ctx, me, id) => confirmTask(ctx, me, id))
  taskAction('assign', 'staff', (b) => TaskAssign.parse(b), (ctx, me, id, { personId }) => assignTask(ctx, me, id, personId))
  taskAction('retry-ai', 'staff', none, (ctx, me, id) => retryAiTask(ctx, me, id))
}
