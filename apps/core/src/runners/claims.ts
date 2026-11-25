import {
  AgentRun,
  AvailableTask,
  type ListTasksInput,
  type Me,
  type RunnerCapability,
  type TemplateTask,
  type WorkflowTemplateDef,
} from '@yoda/shared'
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { invalidState, notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { agentRuns, discussions, events, projectMembers, projects, runners, tasks, workflowTemplates, workItems } from '../db/schema.js'
import { lockProject } from '../projects/access.js'
import { recordEvent, runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { definitionOf, failAiTask, lockItem } from '../work/engine.js'
import { endRun, type RunnerRow } from './records.js'
import { checkSafeguards } from './safeguards.js'

/** An authenticated runner and the staff person it acts for. */
export type RunnerCtx = { runner: RunnerRow; owner: Me }

export type RunnerDeps = WorkDeps & {
  config: WorkDeps['config'] & { runnerLeaseSeconds: number }
  /** Clock for leases and working hours (tests inject one); defaults to the system clock. */
  now?: () => Date
}

type TaskRow = typeof tasks.$inferSelect
type RunRow = typeof agentRuns.$inferSelect

/** Failed or expired runs on one task row after which the task goes back to people. */
export const RUN_STRIKES = 3
const LIST_LIMIT = 20

export const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date()
export const leaseFrom = (deps: RunnerDeps, now: Date) => new Date(now.getTime() + deps.config.runnerLeaseSeconds * 1000)
export const asOwner = (rc: RunnerCtx) => ({ id: rc.owner.id, kind: 'ai' as const })

const priorityRank = sql`case ${workItems.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`

/** Not waiting on a runner's question: no parked discussion, or it has been decided. */
const notParked = or(
  isNull(tasks.parkedDiscussionId),
  sql`exists (select 1 from ${discussions} d where d.id = ${tasks.parkedDiscussionId} and d.state = 'decided')`,
)

/** The AI gave up on the task (latest `ai.failed` / `ai.retried` is a failure): it waits for people. */
const aiGaveUp = sql`coalesce((
  select e.type = 'ai.failed' from ${events} e
  where e.task_id = ${tasks.id} and e.type in ('ai.failed', 'ai.retried')
  order by e.seq desc limit 1
), false)`

function templateTaskOf(def: WorkflowTemplateDef, task: TaskRow): TemplateTask | undefined {
  return def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
}

/** Capabilities this runner may be offered: its own, narrowed by the request; never `draft-text`. */
function offered(rc: RunnerCtx, input: ListTasksInput): RunnerCapability[] {
  const own = rc.runner.capabilities as RunnerCapability[]
  return input.capabilities ? own.filter((c) => input.capabilities!.includes(c)) : own
}

/**
 * Tasks the runner may claim unattended, urgent first then oldest (at most 20): open, unassigned AI tasks of
 * the current step of an active work item, not superseded or parked, whose capability the runner has, in
 * projects the owner sees that are not no-AI. An on-demand runner never polls the queue: 409 `invalid_state`
 * (`on_demand_runner`); it claims a task by id (`yoda-runner work <id>`).
 */
export async function listAvailableTasks(deps: RunnerDeps, rc: RunnerCtx, input: ListTasksInput): Promise<AvailableTask[]> {
  if (rc.runner.mode === 'on-demand') throw invalidState('on_demand_runner')
  const caps = offered(rc, input)
  if (caps.length === 0) return []
  const capList = sql.join(caps.map((c) => sql`${c}`), sql`, `)
  const visible = rc.owner.isAdmin
    ? undefined
    : sql`exists (select 1 from ${projectMembers} pm where pm.project_id = ${tasks.projectId} and pm.person_id = ${rc.owner.id})`
  const rows = await deps.db
    .select({ t: tasks, w: workItems, projectName: projects.name, definition: workflowTemplates.definition })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .where(
      and(
        eq(tasks.executor, 'ai'),
        eq(tasks.state, 'open'),
        isNull(tasks.assigneeId),
        isNull(tasks.supersededAt),
        eq(workItems.state, 'active'),
        eq(tasks.stepKey, workItems.currentStepKey),
        eq(projects.noAi, false),
        visible,
        notParked,
        sql`not ${aiGaveUp}`,
        sql`exists (
          select 1 from jsonb_array_elements(${workflowTemplates.definition} -> 'steps') s,
            jsonb_array_elements(s -> 'tasks') tt
          where s ->> 'key' = ${tasks.stepKey} and tt ->> 'key' = ${tasks.templateTaskKey}
            and tt ->> 'capability' in (${capList})
        )`,
      ),
    )
    .orderBy(priorityRank, asc(tasks.createdAt), asc(tasks.id))
    .limit(LIST_LIMIT)
  return rows.map(({ t, w, projectName, definition }) => {
    const tt = templateTaskOf(definition as WorkflowTemplateDef, t)!
    return AvailableTask.parse({
      taskId: t.id,
      title: tt.title,
      workItemId: w.id,
      workItemTitle: w.title,
      projectName,
      capability: tt.capability,
      stepKey: t.stepKey,
      priority: w.priority,
      createdAt: t.createdAt.toISOString(),
    })
  })
}

function toAgentRun(run: RunRow, runnerName: string): AgentRun {
  return AgentRun.parse({
    id: run.id,
    taskId: run.taskId,
    runnerId: run.runnerId,
    runnerName,
    state: run.state,
    startedAt: run.startedAt.toISOString(),
    heartbeatAt: run.heartbeatAt.toISOString(),
    leaseExpiresAt: run.leaseExpiresAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    branch: run.branch,
    error: run.error,
    usage: run.usage ?? null,
  })
}

async function ownerSeesProject(tx: Tx, owner: Me, projectId: string): Promise<boolean> {
  if (owner.isAdmin) return true
  const [m] = await tx
    .select({ id: projectMembers.personId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, owner.id)))
  return !!m
}

/**
 * Claims a task for the runner (as `{ owner, ai }`). Locks project (share) → work item → task, then the
 * runner row, re-checking revoke / pause on that fresh row. Unattended claims take open, unassigned AI tasks
 * (as listed); the owner's own assigned task (any executor) may be claimed on demand. Refusals are 409
 * `invalid_state` with a `reason`.
 */
export async function claimTask(deps: RunnerDeps, rc: RunnerCtx, taskId: string): Promise<{ run: AgentRun }> {
  const now = nowOf(deps)
  return runWork(deps, asOwner(rc), async (ctx) => {
    const { tx } = ctx
    // project_id / work_item_id never change, so an unlocked read finds what to lock.
    const [ref] = await tx.select({ projectId: tasks.projectId, workItemId: tasks.workItemId }).from(tasks).where(eq(tasks.id, taskId))
    if (!ref) throw notFound()
    await lockProject(tx, ref.projectId, 'share')
    const item = await lockItem(tx, ref.workItemId)
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
    if (!task) throw notFound()
    // NO KEY UPDATE (not just SHARE): also serialises this runner's claims, so max_concurrent holds under
    // concurrency. The revoke's update waits for it, and a revoke that committed first is seen here.
    const [runner] = await tx.select().from(runners).where(eq(runners.id, rc.runner.id)).for('no key update')
    if (!runner || runner.revokedAt) throw invalidState('runner_revoked')
    if (!(await ownerSeesProject(tx, rc.owner, task.projectId))) throw notFound()

    const def = await definitionOf(tx, item)
    const tt = templateTaskOf(def, task)
    const own = task.assigneeId === rc.owner.id
    const [parked] = task.parkedDiscussionId
      ? await tx.select({ state: discussions.state }).from(discussions).where(eq(discussions.id, task.parkedDiscussionId))
      : []
    const current = item.state === 'active' && !task.supersededAt && task.stepKey === item.currentStepKey && (!parked || parked.state === 'decided')
    const eligible =
      current &&
      (own
        ? task.state === 'open' || task.state === 'in_progress'
        : task.executor === 'ai' &&
          task.state === 'open' &&
          task.assigneeId === null &&
          !!tt?.capability &&
          tt.capability !== 'draft-text' &&
          runner.capabilities.includes(tt.capability) &&
          !(await gaveUp(tx, task.id)))
    if (!eligible) throw invalidState('task_unavailable')
    // A runner's result carries no approve / changes decision: review and approval tasks stay with people.
    if (task.type === 'review' || task.type === 'approval') throw invalidState('needs_decision')
    const [running] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.taskId, task.id), eq(agentRuns.state, 'running')))
    if (running) throw invalidState('already_claimed')

    // Claiming the owner's own assigned task is on demand, whatever the runner's mode.
    const unattended = runner.mode === 'unattended' && task.assigneeId === null
    const refusal = await checkSafeguards(tx, { runner, owner: rc.owner }, { unattended, projectId: task.projectId, now })
    if (refusal) throw invalidState(refusal)

    if (task.state === 'open') {
      await tx.update(tasks).set({ state: 'in_progress', updatedAt: sql`now()` }).where(eq(tasks.id, task.id))
    }
    const [run] = await tx
      .insert(agentRuns)
      .values({ taskId: task.id, runnerId: runner.id, ownerId: rc.owner.id, heartbeatAt: now, leaseExpiresAt: leaseFrom(deps, now) })
      .returning()
    await recordEvent(ctx, {
      type: 'run.claimed',
      projectId: task.projectId,
      workItemId: task.workItemId,
      taskId: task.id,
      payload: { runId: run!.id, runnerId: runner.id },
    })
    return { run: toAgentRun(run!, runner.name) }
  })
}

async function gaveUp(tx: Tx, taskId: string): Promise<boolean> {
  const [row] = await tx.select({ v: sql<boolean>`${aiGaveUp}` }).from(tasks).where(eq(tasks.id, taskId))
  return !!row?.v
}

/**
 * The run, when it is `running`, belongs to this runner and its lease has not passed; else 409
 * `invalid_state` (`run_not_active`). Takes no lock: callers lock the task (global order) before writing.
 */
export async function requireLiveRun(tx: Db | Tx, rc: RunnerCtx, runId: string, now: Date = new Date()): Promise<RunRow> {
  const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId))
  if (!run || run.runnerId !== rc.runner.id || run.state !== 'running' || run.leaseExpiresAt <= now) {
    throw invalidState('run_not_active')
  }
  return run
}

/** Extends a live run's lease from now. */
export async function heartbeat(deps: RunnerDeps, rc: RunnerCtx, runId: string): Promise<{ leaseExpiresAt: string }> {
  const now = nowOf(deps)
  // One conditional update: a run that expired (or was swept) meanwhile is never revived.
  const [run] = await deps.db
    .update(agentRuns)
    .set({ heartbeatAt: now, leaseExpiresAt: leaseFrom(deps, now) })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.runnerId, rc.runner.id),
        eq(agentRuns.state, 'running'),
        gt(agentRuns.leaseExpiresAt, now),
      ),
    )
    .returning()
  if (!run) throw invalidState('run_not_active')
  await publishHeartbeat(deps, run.id, run.taskId, now)
  return { leaseExpiresAt: run.leaseExpiresAt.toISOString() }
}

const HEARTBEAT_LIVE_MS = 60_000
/** When each run last told the live stream about a heartbeat (in-process; at most once a minute per run). */
const heartbeatPublished = new Map<string, number>()

/** A live-only `run.heartbeat`, addressed to the project, so staff pages showing the run refresh its age. */
async function publishHeartbeat(deps: RunnerDeps, runId: string, taskId: string, now: Date): Promise<void> {
  const last = heartbeatPublished.get(runId)
  if (last !== undefined && now.getTime() - last < HEARTBEAT_LIVE_MS) return
  for (const [id, at] of heartbeatPublished) if (now.getTime() - at > 10 * HEARTBEAT_LIVE_MS) heartbeatPublished.delete(id)
  heartbeatPublished.set(runId, now.getTime())
  const [t] = await deps.db.select({ projectId: tasks.projectId, workItemId: tasks.workItemId }).from(tasks).where(eq(tasks.id, taskId))
  if (!t) return
  // Project-addressed: only staff who can see the project receive it (see `deliverable`); never requesters.
  deps.bus.publish({ type: 'run.heartbeat', projectId: t.projectId, workItemId: t.workItemId, taskId, conversationId: null, personId: null })
}

/** Locks the task's project (share), work item and task, in the global order. */
export async function lockRunTask(tx: Tx, taskId: string): Promise<TaskRow> {
  const [ref] = await tx.select({ projectId: tasks.projectId, workItemId: tasks.workItemId }).from(tasks).where(eq(tasks.id, taskId))
  if (!ref) throw notFound()
  await lockProject(tx, ref.projectId, 'share')
  await lockItem(tx, ref.workItemId)
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
  if (!task) throw notFound()
  return task
}

/**
 * Three strikes: once the task row has `RUN_STRIKES` failed or expired runs (since the last `ai.retried`),
 * an AI task goes back to people through `failAiTask` (reason `runner_failed`). The task must be locked.
 */
async function applyStrikes(ctx: WorkCtx, taskId: string): Promise<void> {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.taskId, taskId),
        inArray(agentRuns.state, ['failed', 'expired']),
        sql`${agentRuns.endedAt} > coalesce((
          select max(e.created_at) from ${events} e where e.task_id = ${taskId} and e.type = 'ai.retried'
        ), '-infinity'::timestamptz)`,
      ),
    )
  if ((row?.n ?? 0) >= RUN_STRIKES) await failAiTask(ctx, taskId, 'runner_failed')
}

/**
 * The runner gives a live run back: `failed` (a strike) or `released`. The task returns to the queue when it
 * is an unassigned AI task.
 */
export async function releaseRun(
  deps: RunnerDeps,
  rc: RunnerCtx,
  input: { runId: string; reason: string; failed: boolean },
): Promise<void> {
  const now = nowOf(deps)
  await runWork(deps, asOwner(rc), async (ctx) => {
    const run = await requireLiveRun(ctx.tx, rc, input.runId, now)
    await lockRunTask(ctx.tx, run.taskId)
    const ended = await endRun(ctx, run.id, {
      state: input.failed ? 'failed' : 'released',
      event: input.failed ? 'run.failed' : 'run.released',
      reason: input.failed ? 'runner_failed' : 'runner_released',
      error: input.failed ? input.reason : null,
      where: and(eq(agentRuns.runnerId, rc.runner.id), gt(agentRuns.leaseExpiresAt, now)),
      payload: { note: input.reason },
    })
    if (!ended) throw invalidState('run_not_active')
    if (input.failed) await applyStrikes(ctx, run.taskId)
  })
}

/**
 * The `runner-lease-sweep` job: running runs whose lease has passed become `expired`, one transaction each.
 * Unassigned AI tasks go back to the queue; a task assigned to a person stays with them. Expiries are strikes.
 */
export async function expireLeases(deps: RunnerDeps): Promise<void> {
  const now = nowOf(deps)
  const due = await deps.db
    .select({ id: agentRuns.id, taskId: agentRuns.taskId })
    .from(agentRuns)
    .where(and(eq(agentRuns.state, 'running'), lt(agentRuns.leaseExpiresAt, now)))
    .orderBy(asc(agentRuns.leaseExpiresAt))
  for (const r of due) {
    // One run's failure (e.g. a deadlock victim) must not stop the sweep; the next sweep retries it.
    try {
      await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
        await lockRunTask(ctx.tx, r.taskId)
        // A heartbeat that landed meanwhile keeps the run alive.
        const ended = await endRun(ctx, r.id, { state: 'expired', event: 'run.expired', reason: 'lease_expired', where: lt(agentRuns.leaseExpiresAt, now) })
        if (ended) await applyStrikes(ctx, r.taskId)
      })
    } catch (err) {
      console.error(`runner-lease-sweep: failed to expire run ${r.id}`, err)
    }
  }
}
