import { ACTIVE_TASK_STATES, type TemplateStep } from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Tx } from '../db/client.js'
import { agentRuns, events, mergeRequests, projectRepos, tasks, workItemRepos } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { notify, projectPms } from '../notifications/service.js'
import { endRun } from '../runners/records.js'
import { runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { acceptTaskAsSystem, definitionOf, lockItem, type WorkItemRow } from '../work/engine.js'
import { implementTask } from './webhook.js'

/**
 * Job `gitlab-mr-effect` `{ id: mergeRequestRowId }`: what an MR's state means for the work item it is linked
 * to now (a relinked MR acts on its current work item only). Runs as the system and goes through the engine.
 * - opened / merged: the step's active code-change task is accepted with the MR links (reason
 *   `mr_opened_in_gitlab`). An opened MR does so at most once per work item: the rework a reviewer asks for
 *   afterwards waits for a new MR, or for the merge. A merged MR accepts the attempt only when the merge is newer
 *   than the attempt (rework pushed to the same MR, then merged), so replaying an old merge accepts nothing.
 * - merged, and every repo of the item has a merged MR: the active review of the code-change task is approved
 *   (reason `merged_in_gitlab`). Only a merge newer than that review counts, so replaying an old merge never
 *   approves a later review attempt.
 * - closed without merge: the project's PMs and the implement assignee are notified (once per MR).
 * Re-running for the same MR state changes nothing; tasks a person already decided are left alone.
 */
export async function runMrEffect(deps: WorkDeps, run: Pick<JobRun, 'id'>): Promise<void> {
  await runWork(deps, { id: null, kind: 'system' }, (ctx) => mrEffect(ctx, run.id))
}

type MrRow = typeof mergeRequests.$inferSelect & { path: string }

const mrOf = async (tx: Tx, id: string): Promise<MrRow | undefined> => {
  const [row] = await tx
    .select({ mr: mergeRequests, path: projectRepos.pathWithNamespace })
    .from(mergeRequests)
    .innerJoin(projectRepos, eq(projectRepos.id, mergeRequests.repoId))
    .where(eq(mergeRequests.id, id))
  return row ? { ...row.mr, path: row.path } : undefined
}

async function mrEffect(ctx: WorkCtx, mergeRequestId: string): Promise<void> {
  const { tx } = ctx
  const ref = await mrOf(tx, mergeRequestId)
  if (!ref?.workItemId) return
  const item = await lockItem(tx, ref.workItemId)
  // Re-read under the work item lock: a relink in between is handled by the job it queued.
  const mr = await mrOf(tx, mergeRequestId)
  if (!mr || mr.workItemId !== item.id) return
  if (mr.state === 'closed') return notifyClosed(ctx, item, mr)
  if (item.state !== 'active' || !item.currentStepKey) return
  const def = await definitionOf(tx, item)
  const step = def.steps.find((s) => s.key === item.currentStepKey)
  if (!step) return
  const codeKeys = step.tasks.filter((t) => t.capability === 'code-change').map((t) => t.key)
  if (!codeKeys.length) return

  let implementAccepted = false
  const impl = await activeTask(tx, item.id, step, codeKeys)
  if (impl) {
    const accepts = mr.state === 'merged' ? await mergedAfter(tx, item.id, mr.id, impl.id) : !(await acceptedImplementBefore(tx, item.id, mr.id))
    if (accepts) {
      implementAccepted = await acceptTaskAsSystem(
        ctx,
        impl.id,
        { text: await implementText(tx, item.id), attachmentIds: [] },
        { reason: 'mr_opened_in_gitlab', payload: { mergeRequestId: mr.id } },
      )
      // A runner still working the task is done: its slot frees now (its later submit is `already_done`).
      if (implementAccepted) await endRunningRun(ctx, impl.id)
    }
  }

  if (mr.state !== 'merged') return
  const reviewKeys = step.tasks.filter((t) => t.type === 'review' && t.dependsOn.some((k) => codeKeys.includes(k))).map((t) => t.key)
  if (!reviewKeys.length) return
  const cur = await lockItem(tx, item.id)
  if (cur.state !== 'active' || cur.currentStepKey !== step.key) return
  const review = await activeTask(tx, item.id, step, reviewKeys)
  if (!review) return
  const merged = await mergedByRepo(tx, item.id)
  if (!merged) return
  // A review created by this run's implement acceptance is newer than the merge event, and is what it merged.
  if (!implementAccepted && !(await mergedAfter(tx, item.id, mr.id, review.id))) return
  await acceptTaskAsSystem(
    ctx,
    review.id,
    { text: `Merged in GitLab: ${merged.map(mrRef).join(', ')}`, decision: 'approve', attachmentIds: [] },
    { reason: 'merged_in_gitlab', payload: { mergeRequestId: mr.id } },
  )
}

/**
 * After a work item's repo links changed (a repo unlinked can complete "every repo merged"): for each item, its
 * most recently merged linked MR, whose gitlab-mr-effect job re-evaluates the item. Queue them after commit.
 */
export async function latestMergedMrs(tx: Tx, workItemIds: string[]): Promise<string[]> {
  if (!workItemIds.length) return []
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT ON (m.work_item_id) m.id FROM merge_requests m
    LEFT JOIN events e ON e.work_item_id = m.work_item_id AND e.type = 'gitlab.mr_merged' AND e.payload->>'mergeRequestId' = m.id::text
    WHERE m.state = 'merged' AND m.work_item_id IN (${sql.join(workItemIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY m.work_item_id, e.seq DESC NULLS LAST, m.id
  `)
  return rows.map((r) => r.id)
}

/** Ends the task's running agent run, if any, as `succeeded` (reason `mr_effect`). The task is locked. */
async function endRunningRun(ctx: WorkCtx, taskId: string): Promise<void> {
  const [run] = await ctx.tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.state, 'running')))
  if (run) await endRun(ctx, run.id, { state: 'succeeded', event: 'run.succeeded', reason: 'mr_effect', reopen: false })
}

const mrRef = (m: { path: string; mrIid: number; url: string }) => `${m.path}!${m.mrIid} (${m.url})`

/** The latest active (not superseded) attempt of one of `keys` in `step`. */
async function activeTask(tx: Tx, workItemId: string, step: TemplateStep, keys: string[]): Promise<{ id: string } | null> {
  const [t] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workItemId, workItemId),
        eq(tasks.stepKey, step.key),
        inArray(tasks.templateTaskKey, keys),
        isNull(tasks.supersededAt),
        inArray(tasks.state, [...ACTIVE_TASK_STATES]),
      ),
    )
    .orderBy(desc(tasks.attempt))
    .limit(1)
  return t ?? null
}

/** This MR already accepted a code-change attempt of the work item. */
async function acceptedImplementBefore(tx: Tx, workItemId: string, mergeRequestId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workItemId, workItemId),
        eq(events.type, 'task.accepted'),
        eq(events.reason, 'mr_opened_in_gitlab'),
        sql`${events.payload}->>'mergeRequestId' = ${mergeRequestId}`,
      ),
    )
    .limit(1)
  return !!row
}

/** The MR's merge (its `gitlab.mr_merged` event on this work item) was recorded after the task was created. */
async function mergedAfter(tx: Tx, workItemId: string, mergeRequestId: string, taskId: string): Promise<boolean> {
  const [mergedAt] = await tx
    .select({ seq: sql<string>`max(${events.seq})` })
    .from(events)
    .where(
      and(
        eq(events.workItemId, workItemId),
        eq(events.type, 'gitlab.mr_merged'),
        sql`${events.payload}->>'mergeRequestId' = ${mergeRequestId}`,
      ),
    )
  const [createdAt] = await tx
    .select({ seq: sql<string>`min(${events.seq})` })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, 'task.created')))
  if (mergedAt?.seq == null || createdAt?.seq == null) return false
  return BigInt(mergedAt.seq) > BigInt(createdAt.seq)
}

/**
 * The merged MRs of the work item when every repo linked to it has at least one, else null (an item with no
 * linked repos never counts as merged).
 */
async function mergedByRepo(tx: Tx, workItemId: string): Promise<{ path: string; mrIid: number; url: string }[] | null> {
  const repos = await tx.select({ repoId: workItemRepos.repoId }).from(workItemRepos).where(eq(workItemRepos.workItemId, workItemId))
  if (!repos.length) return null
  const merged = await tx
    .select({ repoId: mergeRequests.repoId, path: projectRepos.pathWithNamespace, mrIid: mergeRequests.mrIid, url: mergeRequests.url })
    .from(mergeRequests)
    .innerJoin(projectRepos, eq(projectRepos.id, mergeRequests.repoId))
    .where(and(eq(mergeRequests.workItemId, workItemId), eq(mergeRequests.state, 'merged')))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(mergeRequests.mrIid))
  if (!repos.every((r) => merged.some((m) => m.repoId === r.repoId))) return null
  return merged.map(({ path, mrIid, url }) => ({ path, mrIid, url }))
}

/** The implement result: the work item's open and merged MRs. */
async function implementText(tx: Tx, workItemId: string): Promise<string> {
  const rows = await tx
    .select({ path: projectRepos.pathWithNamespace, mrIid: mergeRequests.mrIid, url: mergeRequests.url, title: mergeRequests.title })
    .from(mergeRequests)
    .innerJoin(projectRepos, eq(projectRepos.id, mergeRequests.repoId))
    .where(and(eq(mergeRequests.workItemId, workItemId), inArray(mergeRequests.state, ['opened', 'merged'])))
    .orderBy(asc(projectRepos.pathWithNamespace), asc(mergeRequests.mrIid))
  return ['Merge requests in GitLab:', ...rows.map((r) => `- ${r.path}!${r.mrIid} ${r.title}\n  ${r.url}`)].join('\n')
}

/** Closed without merge: nothing in the workflow changes; the PMs and whoever does the code hear about it. */
async function notifyClosed(ctx: WorkCtx, item: WorkItemRow, mr: MrRow): Promise<void> {
  if (item.state !== 'active') return
  const people = new Set(await projectPms(ctx, item.projectId))
  const impl = await implementTask(ctx.tx, item.id)
  if (impl?.assigneeId) people.add(impl.assigneeId)
  const title = Array.from(`Merge request ถูกปิดโดยไม่ได้ merge: ${mr.path}!${mr.mrIid} ${mr.title}`).slice(0, 300).join('')
  for (const personId of [...people].sort()) {
    await notify(ctx, {
      personId,
      kind: 'work_item_stuck',
      title,
      body: item.title,
      link: `/work-items/${item.id}`,
      dedupeKey: `mr-closed:${mr.id}`,
    })
  }
}
