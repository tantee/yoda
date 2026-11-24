import { ACTIVE_TASK_STATES, type Me, type TaskResult, type TaskState, type WorkflowTemplateDef, type WorkItemCreate } from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import {
  commentRequired,
  decisionRequired,
  forbidden,
  invalidState,
  notFound,
  notMember,
} from '../auth/plugin.js'
import type { Tx } from '../db/client.js'
import { attachments, events, knowledgeEntries, people, projectMembers, projects, tasks, workItems } from '../db/schema.js'
import { confirmEntry, createEntry } from '../knowledge/service.js'
import { lockProject } from '../projects/access.js'
import { latestTemplate, templateById } from '../workflow/seed.js'
import { recordEvent, type WorkCtx } from './context.js'
import { createTaskAttempt } from './tasks.js'

const ACTIVE_STATES: readonly TaskState[] = ACTIVE_TASK_STATES
const isActive = (state: string) => (ACTIVE_STATES as readonly string[]).includes(state)

type WorkItemRow = typeof workItems.$inferSelect
type TaskRow = typeof tasks.$inferSelect

// Lock order everywhere: project row (only work item creation and member removal), then work_items row
// FOR UPDATE, then the task row. Serialising on the work item is what makes concurrent sibling
// completions advance a step once.

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

/**
 * May `me` act on (start / submit) this task they are assigned to? Project members and admins may; anyone
 * else only on a REQUESTER task assigned to them (a requester is not a project member). Returns whether the
 * requester path was used.
 */
async function requireCanActOn(tx: Tx, me: Me, task: TaskRow): Promise<{ asRequester: boolean }> {
  if (task.assigneeId !== me.id) throw forbidden()
  if (me.isAdmin || (await memberRoles(tx, task.projectId, me.id))) return { asRequester: false }
  if (task.role === 'REQUESTER') return { asRequester: true }
  throw forbidden()
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
  // Waits for any in-flight member removal, so the new item's tasks never go to a departing member.
  await lockProject(tx, projectId, 'share')
  if (!me.isAdmin && !(await memberRoles(tx, projectId, me.id))) throw notFound()
  const ownerId = input.ownerId ?? me.id
  if (!(await memberRoles(tx, projectId, ownerId))) throw notMember()
  // Any person may be the requester (staff or not); they need not be a project member.
  const requesterId = input.requesterId ?? null
  if (requesterId) {
    const [p] = await tx.select({ id: people.id }).from(people).where(eq(people.id, requesterId))
    if (!p) throw notFound()
  }
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
      requesterId,
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
      const prevText = prev?.state === 'rejected' ? (prev.result as { text?: string } | null)?.text : undefined
      await createTaskAttempt(ctx, {
        workItemId,
        projectId: item.projectId,
        stepKey: step.key,
        task: t,
        attempt: (prev?.attempt ?? 0) + 1,
        feedback: prevText && prevText.trim() ? prevText : null,
        assigneeHint: prev?.assigneeId ?? null,
        executor: t.type === 'ai' ? 'ai' : 'human',
      })
    }
    return
  }
}

export async function startTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { task } = await lockTask(ctx.tx, taskId)
  await requireCanActOn(ctx.tx, me, task)
  if (task.state !== 'open') throw invalidState()
  await ctx.tx.update(tasks).set({ state: 'in_progress', updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
  await recordEvent(ctx, { type: 'task.started', projectId: task.projectId, workItemId: task.workItemId, taskId })
}

export async function submitTask(ctx: WorkCtx, me: Me, taskId: string, result: TaskResult): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  const { asRequester } = await requireCanActOn(tx, me, task)
  if (task.state !== 'open' && task.state !== 'in_progress') throw invalidState()
  const decides = task.type === 'review' || task.type === 'approval'
  if (decides) {
    if (!result.decision) throw decisionRequired()
    if (result.decision === 'changes' && !result.text.trim()) throw commentRequired()
  }
  const base = { projectId: task.projectId, workItemId: task.workItemId, taskId }
  result = { ...result, attachmentIds: [...new Set(result.attachmentIds)] }
  // A requester may only attach files they uploaded themselves, never other project files.
  await linkAttachments(tx, task, result.attachmentIds, asRequester ? me.id : null)

  if (!decides || result.decision === 'approve') {
    await tx.update(tasks).set({ state: 'accepted', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
    await recordEvent(ctx, { type: 'task.accepted', ...base })
    await recordAcceptedKnowledge(ctx, item, task, result)
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

/**
 * Links attachments to the task. Unknown ids, files of another project, or (with `uploadedBy`) files someone
 * else uploaded → 404 (never confirms other
 * projects' ids). A file already linked to another task, or on another work item → 409 `invalid_state`,
 * so a submit never moves files off other tasks. Project-level files join the task's work item.
 */
async function linkAttachments(tx: Tx, task: TaskRow, ids: string[], uploadedBy: string | null): Promise<void> {
  if (!ids.length) return
  const rows = await tx
    .select({ id: attachments.id, taskId: attachments.taskId, workItemId: attachments.workItemId })
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, ids),
        eq(attachments.projectId, task.projectId),
        uploadedBy ? eq(attachments.uploadedBy, uploadedBy) : undefined,
      ),
    )
    .orderBy(asc(attachments.id))
    .for('update')
  if (rows.length !== ids.length) throw notFound()
  const foreign = (r: (typeof rows)[number]) =>
    (r.taskId !== null && r.taskId !== task.id) || (r.workItemId !== null && r.workItemId !== task.workItemId)
  if (rows.some(foreign)) throw invalidState()
  await tx
    .update(attachments)
    .set({ taskId: task.id, workItemId: task.workItemId })
    .where(inArray(attachments.id, ids))
}

/**
 * Knowledge from accepted work (system writes, no permission checks: the submitter's rights were checked).
 * Call after the task row is `accepted` with `result` (submitTask, and the AI runner's submitAiResult).
 * - An `ai` / `human` task with result text → a `progress` entry; `draft` when the AI did the work.
 * - An approving `review` / `approval` → a confirmed `document` entry for each task it depends on
 *   (latest accepted attempt), and that task's draft progress entries become confirmed.
 */
export async function recordAcceptedKnowledge(ctx: WorkCtx, item: WorkItemRow, task: TaskRow, result: TaskResult): Promise<void> {
  const { tx } = ctx
  const def = await definitionOf(tx, item)
  const step = def.steps.find((s) => s.key === task.stepKey)
  const templateTask = step?.tasks.find((t) => t.key === task.templateTaskKey)
  if (!step || !templateTask) return
  const entry = (sourceTask: TaskRow, title: string, body: string) =>
    ({
      scope: 'work_item',
      projectId: sourceTask.projectId,
      workItemId: sourceTask.workItemId,
      title,
      body,
      noAi: false,
      sourceKind: 'task',
      sourceRef: sourceTask.id,
    }) as const

  if (task.type === 'ai' || task.type === 'human') {
    if (!result.text.trim()) return
    await createEntry(ctx, null, {
      ...entry(task, templateTask.title.th, result.text),
      type: 'progress',
      status: task.executor === 'ai' ? 'draft' : 'confirmed',
    })
    return
  }
  if (result.decision !== 'approve') return
  for (const depKey of templateTask.dependsOn) {
    const depDef = step.tasks.find((t) => t.key === depKey)
    const [dep] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.workItemId, task.workItemId), eq(tasks.templateTaskKey, depKey), eq(tasks.state, 'accepted')))
      .orderBy(desc(tasks.attempt))
      .limit(1)
    if (!dep || !depDef) continue
    const text = (dep.result as TaskResult | null)?.text ?? ''
    if (text.trim()) {
      await createEntry(ctx, null, { ...entry(dep, depDef.title.th, text), type: 'document', status: 'confirmed' })
    }
    const drafts = await tx
      .select({ id: knowledgeEntries.id })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.sourceKind, 'task'),
          eq(knowledgeEntries.sourceRef, dep.id),
          eq(knowledgeEntries.type, 'progress'),
          eq(knowledgeEntries.status, 'draft'),
          isNull(knowledgeEntries.supersededAt),
        ),
      )
      .orderBy(asc(knowledgeEntries.id))
      // Locked, and the filter is re-checked after any wait: a draft a person edited or confirmed
      // meanwhile is no longer a current draft and is skipped instead of failing the approval.
      .for('update')
    for (const d of drafts) await confirmEntry(ctx, null, d.id)
  }
}

export async function assignTask(ctx: WorkCtx, me: Me, taskId: string, personId: string): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (!isActive(task.state)) throw invalidState()
  // A REQUESTER task may also go (back) to the work item's requester, who is usually not a member.
  const toRequester = task.role === 'REQUESTER' && personId === item.requesterId
  if (!toRequester && !(await memberRoles(tx, task.projectId, personId))) throw notMember()
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

export async function confirmTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { tx } = ctx
  const { task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (task.state !== 'proposed' || !task.proposedAssigneeId) throw invalidState()
  const assigneeId = task.proposedAssigneeId
  if (!(await memberRoles(tx, task.projectId, assigneeId))) throw notMember()
  await tx
    .update(tasks)
    .set({ assigneeId, proposedAssigneeId: null, state: 'open', updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'task.assigned',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    payload: { assigneeId },
  })
}

/**
 * Called when `personId` leaves the project (after the membership row is deleted, same transaction):
 * every active task they hold or are proposed for becomes unassigned `open`, so it lands in the PM's
 * confirmations — except REQUESTER tasks they hold as the work item's requester.
 *
 * Locks the project, then every active work item of the project (not only the ones holding this
 * person's tasks), then reads the tasks. A concurrent progress/assign holds a work item lock while it
 * picks an assignee from a membership snapshot that may still include this person; waiting for all
 * item locks means such a task is committed, and therefore visible, before we look for it. New items
 * cannot appear meanwhile because createWorkItem takes the project lock in share mode.
 */
export async function unassignMemberTasks(ctx: WorkCtx, projectId: string, personId: string): Promise<void> {
  const { tx } = ctx
  await lockProject(tx, projectId)
  await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.state, 'active')))
    .orderBy(asc(workItems.id))
    .for('update')
  const cleared = await tx
    .update(tasks)
    .set({ assigneeId: null, proposedAssigneeId: null, state: 'open', updatedAt: sql`now()` })
    .where(
      and(
        eq(tasks.projectId, projectId),
        inArray(tasks.state, [...ACTIVE_STATES]),
        or(eq(tasks.assigneeId, personId), eq(tasks.proposedAssigneeId, personId)),
        // The work item's requester keeps their requester tasks: those never depended on membership.
        sql`not (${tasks.role} = 'REQUESTER' and ${tasks.assigneeId} is not distinct from (select w.requester_id from work_items w where w.id = ${tasks.workItemId}))`,
      ),
    )
    .returning({ id: tasks.id, workItemId: tasks.workItemId })
  cleared.sort((a, b) => (a.workItemId + a.id).localeCompare(b.workItemId + b.id))
  for (const t of cleared) {
    await recordEvent(ctx, {
      type: 'task.unassigned',
      projectId,
      workItemId: t.workItemId,
      taskId: t.id,
      reason: 'member_removed',
      payload: { personId },
    })
  }
}

export async function cancelWorkItem(ctx: WorkCtx, me: Me, workItemId: string): Promise<void> {
  const { tx } = ctx
  const item = await lockItem(tx, workItemId)
  const ownerStillMember = item.ownerId === me.id && (await memberRoles(tx, item.projectId, me.id)) !== null
  if (!ownerStillMember && !(await isPmOrAdmin(tx, me, item.projectId))) throw forbidden()
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

/** The AI runner may still act on the task: open, unassigned and executed by the AI. */
const awaitingAi = (task: TaskRow) => task.state === 'open' && task.assigneeId === null && task.executor === 'ai'

/**
 * Stores an AI draft as the task's result (actor kind `ai`). No-op when the task was taken over, cancelled or
 * already finished meanwhile. Records `ai.drafted` then `task.accepted`, a draft progress entry, then advances
 * the work item so the next (human) task appears.
 */
export async function submitAiResult(
  ctx: WorkCtx,
  taskId: string,
  text: string,
  meta: { model: string; overBudget?: boolean },
): Promise<boolean> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (item.state !== 'active' || !awaitingAi(task)) return false
  const result: TaskResult = { text, attachmentIds: [] }
  const base = { projectId: task.projectId, workItemId: task.workItemId, taskId }
  await tx.update(tasks).set({ state: 'accepted', result, updatedAt: sql`now()` }).where(eq(tasks.id, taskId))
  await recordEvent(ctx, {
    type: 'ai.drafted',
    ...base,
    payload: meta.overBudget ? { model: meta.model, overBudget: true } : { model: meta.model },
  })
  await recordEvent(ctx, { type: 'task.accepted', ...base })
  await recordAcceptedKnowledge(ctx, item, task, result)
  await progressWorkItem(ctx, task.workItemId)
  return true
}

/**
 * Records that the AI could not draft the task (`ai.failed` with `reason`, actor kind `system`). The task stays
 * open and unassigned, so it remains in the PM's confirmations. No-op when it no longer awaits the AI.
 */
export async function failAiTask(ctx: WorkCtx, taskId: string, reason: string): Promise<void> {
  const { item, task } = await lockTask(ctx.tx, taskId)
  if (item.state !== 'active' || !awaitingAi(task)) return
  await recordEvent(ctx, {
    type: 'ai.failed',
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId,
    reason,
  })
}

/** PM/admin: queue another drafting attempt for an open, unassigned `draft-text` AI task. */
export async function retryAiTask(ctx: WorkCtx, me: Me, taskId: string): Promise<void> {
  const { tx } = ctx
  const { item, task } = await lockTask(tx, taskId)
  if (!(await isPmOrAdmin(tx, me, task.projectId))) throw forbidden()
  if (item.state !== 'active' || !awaitingAi(task)) throw invalidState()
  const def = await definitionOf(tx, item)
  const templateTask = def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
  if (templateTask?.capability !== 'draft-text') throw invalidState()
  const [proj] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, task.projectId))
  if (!proj || proj.noAi) throw invalidState()
  // After a failed draft, or when no draft was ever attempted (e.g. its job was lost). A pending ai.retried
  // means a job is already queued. A duplicate job is harmless: the draft-task queue keeps one per task.
  const [last] = await tx
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.taskId, taskId), like(events.type, 'ai.%')))
    .orderBy(desc(events.seq))
    .limit(1)
  if (last && last.type !== 'ai.failed') throw invalidState()
  await recordEvent(ctx, { type: 'ai.retried', projectId: task.projectId, workItemId: task.workItemId, taskId })
  ctx.jobs.push({ name: 'draft-task', id: taskId })
}

/**
 * After a project's noAi is switched off: queues drafting for every `draft-text` task still waiting on the AI
 * (recording `ai.retried` where the last attempt failed, so the task shows as drafting again) and re-embeds the
 * project's current entries that have chunks without vectors.
 */
export async function resumeProjectAi(ctx: WorkCtx, projectId: string): Promise<void> {
  const { tx } = ctx
  const waiting = await tx
    .select({ task: tasks, item: workItems })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.state, 'open'),
        eq(tasks.executor, 'ai'),
        isNull(tasks.assigneeId),
        eq(workItems.state, 'active'),
      ),
    )
  const defs = new Map<string, WorkflowTemplateDef>()
  for (const { task, item } of waiting) {
    let def = defs.get(item.templateId)
    if (!def) defs.set(item.templateId, (def = await definitionOf(tx, item)))
    const tt = def.steps.find((s) => s.key === task.stepKey)?.tasks.find((t) => t.key === task.templateTaskKey)
    if (tt?.capability !== 'draft-text') continue
    const [last] = await tx
      .select({ type: events.type })
      .from(events)
      .where(and(eq(events.taskId, task.id), like(events.type, 'ai.%')))
      .orderBy(desc(events.seq))
      .limit(1)
    if (last?.type === 'ai.failed') {
      await recordEvent(ctx, { type: 'ai.retried', projectId, workItemId: task.workItemId, taskId: task.id })
    }
    ctx.jobs.push({ name: 'draft-task', id: task.id })
  }
  const unembedded = await tx
    .select({ id: knowledgeEntries.id })
    .from(knowledgeEntries)
    .leftJoin(attachments, eq(attachments.id, knowledgeEntries.attachmentId))
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.supersededAt),
        eq(knowledgeEntries.noAi, false),
        or(isNull(attachments.id), eq(attachments.noAi, false)),
        sql`exists (select 1 from knowledge_chunks c where c.entry_id = ${knowledgeEntries.id} and c.embedding is null)`,
      ),
    )
  for (const e of unembedded) ctx.jobs.push({ name: 'embed-entry', id: e.id })
}
