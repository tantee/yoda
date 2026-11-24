import type { EventType, LiveEvent } from '@yoda/shared'
import type { Db, Tx } from '../db/client.js'
import { events } from '../db/schema.js'
import type { JobName, JobQueue } from '../jobs/queue.js'
import type { LiveBus } from '../live/bus.js'

export type WorkCtx = {
  tx: Tx
  actorId: string | null
  emitted: LiveEvent[]
  /** Jobs to send once the transaction has committed. */
  jobs: { name: JobName; id: string }[]
}

export type WorkDeps = { db: Db; bus: LiveBus; jobs: Pick<JobQueue, 'send'> }

export async function runWork<T>(
  deps: WorkDeps,
  actorId: string | null,
  fn: (ctx: WorkCtx) => Promise<T>,
): Promise<T> {
  const emitted: LiveEvent[] = []
  const jobs: WorkCtx['jobs'] = []
  const result = await deps.db.transaction((tx) => fn({ tx, actorId, emitted, jobs }))
  for (const e of emitted) deps.bus.publish(e)
  for (const j of jobs) {
    // Committed work stays committed: a queue outage loses the job (it is logged), not the request.
    try {
      await deps.jobs.send(j.name, { id: j.id })
    } catch (err) {
      console.error(`jobs: failed to send ${j.name} ${j.id}`, err)
    }
  }
  return result
}

export async function recordEvent(
  ctx: WorkCtx,
  e: {
    type: EventType
    projectId: string
    workItemId: string | null
    taskId: string | null
    reason?: string | null
    actorKind?: 'person' | 'system' | 'ai'
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await ctx.tx.insert(events).values({
    projectId: e.projectId,
    workItemId: e.workItemId,
    taskId: e.taskId,
    type: e.type,
    actorId: ctx.actorId,
    ...(e.actorKind ? { actorKind: e.actorKind } : {}),
    reason: e.reason ?? null,
    payload: e.payload ?? {},
  })
  ctx.emitted.push({ type: e.type, projectId: e.projectId, workItemId: e.workItemId, taskId: e.taskId })
}
