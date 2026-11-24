import type { ActorKind, EventType, LiveEvent } from '@yoda/shared'
import type { Db, Tx } from '../db/client.js'
import { events } from '../db/schema.js'
import type { JobName, JobQueue } from '../jobs/queue.js'
import type { LiveBus } from '../live/bus.js'

export type WorkCtx = {
  tx: Tx
  actorId: string | null
  /** Who is acting: a person (actorId set), the system (actorId null) or the AI runner. */
  actorKind: ActorKind
  emitted: LiveEvent[]
  /** Jobs to send once the transaction has committed. */
  jobs: { name: JobName; id: string }[]
  /** Daily cap on automatic task assignments per person (config `dailyTaskCap`). */
  dailyTaskCap: number
}

export type Actor = { id: string | null; kind: ActorKind }

export const DEFAULT_DAILY_TASK_CAP = 8

export type WorkDeps = {
  db: Db
  bus: LiveBus
  jobs: Pick<JobQueue, 'send'>
  config?: { dailyTaskCap: number }
}

export async function runWork<T>(
  deps: WorkDeps,
  actor: Actor,
  fn: (ctx: WorkCtx) => Promise<T>,
): Promise<T> {
  const emitted: LiveEvent[] = []
  const jobs: WorkCtx['jobs'] = []
  const result = await deps.db.transaction((tx) => fn({
      tx,
      actorId: actor.id,
      actorKind: actor.kind,
      emitted,
      jobs,
      dailyTaskCap: deps.config?.dailyTaskCap ?? DEFAULT_DAILY_TASK_CAP,
    }),
  )
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
    /** Defaults to the context's actor kind. */
    actorKind?: ActorKind
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await ctx.tx.insert(events).values({
    projectId: e.projectId,
    workItemId: e.workItemId,
    taskId: e.taskId,
    type: e.type,
    actorId: ctx.actorId,
    actorKind: e.actorKind ?? ctx.actorKind,
    reason: e.reason ?? null,
    payload: e.payload ?? {},
  })
  ctx.emitted.push({
    type: e.type,
    projectId: e.projectId,
    workItemId: e.workItemId,
    taskId: e.taskId,
    conversationId: null,
    personId: null,
  })
}
