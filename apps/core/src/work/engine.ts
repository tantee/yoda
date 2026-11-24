import type { Me, TaskResult, TaskState, WorkflowTemplateDef, WorkItemCreate } from '@yoda/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  commentRequired,
  decisionRequired,
  forbidden,
  invalidState,
  notFound,
  notMember,
} from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { projectMembers, tasks, workItems } from '../db/schema.js'
import { latestTemplate, templateById } from '../workflow/seed.js'
import { recordEvent, type WorkCtx } from './context.js'
import { createTaskAttempt } from './tasks.js'

const ACTIVE_STATES: readonly TaskState[] = ['proposed', 'open', 'in_progress', 'submitted']
const isActive = (state: string) => (ACTIVE_STATES as readonly string[]).includes(state)

type WorkItemRow = typeof workItems.$inferSelect
type TaskRow = typeof tasks.$inferSelect

// Lock order everywhere: work_items row FOR UPDATE first, then the task row.
// Serialising on the work item is what makes concurrent sibling completions advance a step once.

async function lockItem(tx: Tx, workItemId: string): Promise<WorkItemRow> {
  const [row] = await tx.select().from(workItems).where(eq(workItems.id, workItemId)).for('update')
  if (!row) throw notFound()
  return row
}

/** Locks the task's work item, then the task itself; both rows are re-read under the lock. */
async function lockTask(tx: Tx, taskId: string): Promise<{ item: WorkItemRow; task: TaskRow }> {
  // work_item_id never changes, so an unlocked read is enough to find which item to lock.
  const [ref] = await tx.select({ workItemId: tasks.workItemId }).from(tasks).where(eq(tasks.id, taskId))
  if (!ref) throw notFound()
  const item = await lockItem(tx, ref.workItemId)
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
  if (!task) throw notFound()
  return { item, task }
}

async function memberRoles(tx: Tx, projectId: string, personId: string): Promise<string[] | null> {
  const [row] = await tx
    .select({ roles: projectMembers.roles })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)))
  return row?.roles ?? null
}

async function isPmOrAdmin(tx: Tx, me: Me, projectId: string): Promise<boolean> {
  if (me.isAdmin) return true
  return (await memberRoles(tx, projectId, me.id))?.includes('PM') ?? false
}

async function definitionOf(tx: Tx, item: WorkItemRow): Promise<WorkflowTemplateDef> {
  const def = await templateById(tx, item.templateId)
  if (!def) throw new Error(`workflow template ${item.templateId} missing`)
  return def
}

export async function createWorkItem(
  ctx: WorkCtx,
  me: Me,
  projectId: string,
  input: WorkItemCreate,
): Promise<string> {
  const { tx } = ctx
  if (!me.isAdmin && !(await memberRoles(tx, projectId, me.id))) throw notFound()
  const ownerId = input.ownerId ?? me.id
  if (!(await memberRoles(tx, projectId, ownerId))) throw notMember()
  const template = await latestTemplate(tx, input.templateKey)
  if (!template) throw notFound()

  const [row] = await tx
    .insert(workItems)
    .values({
      projectId,
      templateId: template.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      ownerId,
      createdBy: me.id,
    })
    .returning({ id: workItems.id })
  const workItemId = row!.id
  await recordEvent(ctx, { type: 'work_item.created', projectId, workItemId, taskId: null })
  await startWorkItem(ctx, workItemId)
  return workItemId
}

export async function startWorkItem(ctx: WorkCtx, workItemId: string): Promise<void> {
  const item = await lockItem(ctx.tx, workItemId)
  const def = await definitionOf(ctx.tx, item)
  await ctx.tx
    .update(workItems)
    .set({ currentStepKey: def.steps[0]!.key, updatedAt: sql`now()` })
    .where(eq(workItems.id, workItemId))
  await progressWorkItem(ctx, workItemId)
}

export async function progressWorkItem(ctx: WorkCtx, workItemId: string): Promise<void> {
  const { tx } = ctx
  for (;;) {
    const item = await lockItem(tx, workItemId)
    if (item.state !== 'active') return
    const def = await definitionOf(tx, item)
    const stepIndex = def.steps.findIndex((s) => s.key === item.currentStepKey)
    if (stepIndex < 0) throw new Error(`work item ${workItemId} has unknown step ${item.currentStepKey}`)
    const step = def.steps[stepIndex]!
    const next = def.steps[stepIndex + 1]

    const rows = await tx.select().from(tasks).where(eq(tasks.workItemId, workItemId))
    const latest = new Map<string, TaskRow>()
    const active = new Set<string>()
    for (const r of rows) {
      const cur = latest.get(r.templateTaskKey)
      if (!cur || r.attempt > cur.attempt) latest.set(r.templateTaskKey, r)
      if (isActive(r.state)) active.add(r.templateTaskKey)
    }
    const satisfied = (key: string) => latest.get(key)?.state === 'accepted'

    if (step.tasks.every((t) => satisfied(t.key))) {
      const base = { projectId: item.projectId, workItemId, taskId: null }
      await recordEvent(ctx, {
        type: 'work_item.step_advanced',
        ...base,
        payload: { from: step.key, to: next?.key ?? null },
      })
      if (!next) {
        await tx
          .update(workItems)
          .set({ state: 'done', currentStepKey: null, updatedAt: sql`now()` })
          .where(eq(workItems.id, workItemId))
        await recordEvent(ctx, { type: 'work_item.done', ...base })
        return
      }
      await tx
        .update(workItems)
        .set({ currentStepKey: next.key, updatedAt: sql`now()` })
        .where(eq(workItems.id, workItemId))
      continue
    }

    for (const t of step.tasks) {
      if (satisfied(t.key) || active.has(t.key) || !t.dependsOn.every(satisfied)) continue
      const prev = latest.get(t.key)
      await createTaskAttempt(ctx, {
        workItemId,
        projectId: item.projectId,
        stepKey: step.key,
        task: t,
        attempt: (prev?.attempt ?? 0) + 1,
        feedback: null,
        assigneeHint: prev?.assigneeId ?? null,
        executor: t.type === 'ai' ? 'ai' : 'human',
      })
    }
    return
  }
}

export async function startTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { task } = await lockTask(ctx.tx, taskId)
  if (task.assigneeId !== me.id) throw forbidden()
  if (task.state !== 'open') throw invalidState()
  await ctx.tx.update(tasks).set({ state: 'in_progress', updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
  await recordEvent(ctx, { type: 'task.started', projectId: task.projectId, workItemId: task.workItemId, taskId })
}

export async function submitTask(ctx: WorkCtx, me: Me, taskId: string, result: TaskResult): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (task.assigneeId !== me.id) throw forbidden()
  if (task.state !== 'open' && task.state !== 'in_progress') throw invalidState()
  const decides = task.type === 'review' || task.type === 'approval'
  if (decides) {
    if (!result.decision) throw decisionRequired()
    if (result.decision === 'changes' && !result.text.trim()) throw commentRequired()
  }
  const base = { projectId: task.projectId, workItemId: task.workItemId, taskId }

  if (!decides || result.decision === 'approve') {
    await tx.update(tasks).set({ state: 'accepted', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
    await recordEvent(ctx, { type: 'task.accepted', ...base })
  } else {
    const comment = result.text
    await tx.update(tasks).set({ state: 'rejected', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
    await recordEvent(ctx, { type: 'task.rejected', ...base, reason: comment })

    const def = await definitionOf(tx, item)
    const step = def.steps.find((s) => s.key === task.stepKey)
    const templateTask = step?.tasks.find((t) => t.key === task.templateTaskKey)
    for (const depKey of templateTask?.dependsOn ?? []) {
      const depDef = step!.tasks.find((t) => t.key === depKey)!
      const [prev] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workItemId, task.workItemId), eq(tasks.templateTaskKey, depKey)))
        .orderBy(desc(tasks.attempt))
        .limit(1)
      await createTaskAttempt(ctx, {
        workItemId: task.workItemId,
        projectId: task.projectId,
        stepKey: task.stepKey,
        task: depDef,
        attempt: (prev?.attempt ?? 0) + 1,
        feedback: comment,
        assigneeHint: prev?.assigneeId ?? null,
        executor: (prev?.executor as 'ai' | 'human' | undefined) ?? (depDef.type === 'ai' ? 'ai' : 'human'),
      })
    }
  }
  await progressWorkItem(ctx, task.workItemId)
}

export async function assignTask(ctx: WorkCtx, me: Me, taskId: string, personId: string): Promise<void> {
  const { tx } = ctx
  const { task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (!isActive(task.state)) throw invalidState()
  if (!(await memberRoles(tx, task.projectId, personId))) throw notMember()
  const takeover = task.executor === 'ai'
  await tx
    .update(tasks)
    .set({
      assigneeId: personId,
      proposedAssigneeId: null,
      state: task.state === 'proposed' ? 'open' : task.state,
      executor: 'human',
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'task.assigned',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    payload: takeover ? { assigneeId: personId, takeover: true } : { assigneeId: personId },
  })
}

export async function cancelWorkItem(ctx: WorkCtx, me: Me, workItemId: string): Promise<void> {
  const { tx } = ctx
  const item = await lockItem(tx, workItemId)
  if (item.ownerId !== me.id && !(await isPmOrAdmin(tx, me, item.projectId))) throw forbidden()
  if (item.state !== 'active') throw invalidState()

  const rejected = await tx
    .update(tasks)
    .set({ state: 'rejected', updatedAt: sql`now()` })
    .where(and(eq(tasks.workItemId, workItemId), inArray(tasks.state, [...ACTIVE_STATES])))
    .returning({ id: tasks.id })
  for (const r of rejected) {
    await recordEvent(ctx, {
      type: 'task.rejected',
      projectId: item.projectId,
      workItemId,
      taskId: r.id,
      reason: 'work_item_cancelled',
    })
  }
  await tx.update(workItems).set({ state: 'cancelled', updatedAt: sql`now()` }).where(eq(workItems.id, workItemId))
  await recordEvent(ctx, { type: 'work_item.cancelled', projectId: item.projectId, workItemId, taskId: null })
}
