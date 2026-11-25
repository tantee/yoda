import { and, eq, isNull, like, lt, sql } from 'drizzle-orm'
import { errorSummary } from '../ai/gateway.js'
import type { AppDeps } from '../app.js'
import { events, projects, tasks, workItems } from '../db/schema.js'
import { notify, projectPms } from '../notifications/service.js'
import { runWork } from '../work/context.js'
import { definitionOf } from '../work/engine.js'

export type SweepDeps = Pick<AppDeps, 'db' | 'bus' | 'jobs' | 'config'>

/** An active work item with no event for this long is flagged as stuck. */
export const STUCK_AFTER_DAYS = 3
/** An unassigned AI draft with no `ai.*` event after this long lost its `draft-task` job. */
export const ORPHAN_AFTER_MINUTES = 10

const bangkokDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

/** Notifies the owner and the project's PMs about each stuck item, once per person, item and Bangkok day. */
async function flagStuck(deps: SweepDeps): Promise<void> {
  const stuck = await deps.db
    .select({ id: workItems.id, title: workItems.title, projectId: workItems.projectId, ownerId: workItems.ownerId })
    .from(workItems)
    .where(
      and(
        eq(workItems.state, 'active'),
        sql`coalesce((select max(e.created_at) from events e where e.work_item_id = ${workItems.id}), ${workItems.createdAt}) < now() - make_interval(days => ${STUCK_AFTER_DAYS})`,
      ),
    )
  const day = bangkokDate()
  for (const item of stuck) {
    try {
    await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
      const recipients = new Set([item.ownerId, ...(await projectPms(ctx, item.projectId))])
      for (const personId of recipients) {
        await notify(ctx, {
          personId,
          kind: 'work_item_stuck',
          title: `งานนี้ไม่มีความคืบหน้ามา ${STUCK_AFTER_DAYS} วันแล้ว: ${item.title}`,
          body: 'ตรวจสอบว่ามีอะไรติดอยู่ หรือมอบหมายงานต่อ',
          link: `/work-items/${item.id}`,
          dedupeKey: `stuck:${item.id}:${day}`,
        })
      }
    })
    } catch (err) {
      console.error(`secretary-sweep: stuck check failed for work item ${item.id}: ${errorSummary(err)}`)
    }
  }
}

/** Re-queues `draft-task` for open, unassigned AI `draft-text` tasks that never got an `ai.*` event. */
async function requeueOrphans(deps: SweepDeps): Promise<void> {
  const rows = await deps.db
    .select({ task: tasks, item: workItems })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        eq(tasks.state, 'open'),
        eq(tasks.executor, 'ai'),
        isNull(tasks.assigneeId),
        eq(workItems.state, 'active'),
        eq(projects.noAi, false),
        lt(tasks.createdAt, sql`now() - make_interval(mins => ${ORPHAN_AFTER_MINUTES})`),
        sql`not exists (select 1 from ${events} e where e.task_id = ${tasks.id} and e.type like 'ai.%')`,
      ),
    )
  for (const { task, item } of rows) {
    try {
      const def = await deps.db.transaction((tx) => definitionOf(tx, item))
      const tt = def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
      if (tt?.capability !== 'draft-text') continue
      // The draft-task queue keeps one job per task (singletonKey), so a job still queued is not doubled.
      await deps.jobs.send('draft-task', { id: task.id })
    } catch (err) {
      console.error(`secretary-sweep: orphan check failed for task ${task.id}: ${errorSummary(err)}`)
    }
  }
}

/** `secretary-sweep` job (every 15 minutes): stuck work and orphaned AI drafts. */
export async function secretarySweep(deps: SweepDeps): Promise<void> {
  await flagStuck(deps)
  await requeueOrphans(deps)
}
