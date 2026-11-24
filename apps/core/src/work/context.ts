import type { EventType, LiveEvent } from '@yoda/shared'
import type { Db, Tx } from '../db/client.js'
import { events } from '../db/schema.js'
import type { LiveBus } from '../live/bus.js'

export type WorkCtx = { tx: Tx; actorId: string | null; emitted: LiveEvent[] }

export async function runWork<T>(
  deps: { db: Db; bus: LiveBus },
  actorId: string | null,
  fn: (ctx: WorkCtx) => Promise<T>,
): Promise<T> {
  const emitted: LiveEvent[] = []
  const result = await deps.db.transaction((tx) => fn({ tx, actorId, emitted }))
  for (const e of emitted) deps.bus.publish(e)
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
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await ctx.tx.insert(events).values({
    projectId: e.projectId,
    workItemId: e.workItemId,
    taskId: e.taskId,
    type: e.type,
    actorId: ctx.actorId,
    reason: e.reason ?? null,
    payload: e.payload ?? {},
  })
  ctx.emitted.push({ type: e.type, projectId: e.projectId, workItemId: e.workItemId, taskId: e.taskId })
}
