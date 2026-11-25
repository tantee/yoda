import type { GuardReason, TaskExecutor, TemplateTask } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { Tx } from '../db/client.js'
import { projectMembers, projects, tasks, workItems } from '../db/schema.js'
import { notifyTaskAssigned, notifyTaskProposed } from '../notifications/service.js'
import { lockAutoAssign, pickAssignee } from './assign.js'
import { templateById } from '../workflow/seed.js'
import { queueMrReconcile } from '../gitlab/reconcile.js'
import { queueIssueSync } from '../gitlab/sync.js'
import { recordEvent, type WorkCtx } from './context.js'
import { guardText, REPEATED_REWORK, reworkCount } from './guards.js'

export async function createTaskAttempt(
  ctx: WorkCtx,
  input: {
    workItemId: string
    projectId: string
    stepKey: string
    task: TemplateTask
    attempt: number
    feedback: string | null
    assigneeHint: string | null
    executor: TaskExecutor
  },
): Promise<string> {
  const { tx } = ctx
  let state: 'open' | 'proposed' = 'open'
  let assigneeId: string | null = null
  let proposedAssigneeId: string | null = null
  let noCandidate = false
  // An `auto-assign` guard rail that turned an automatic assignment into a proposal.
  let guard: GuardReason | null = null
  // Automatic staff assignments carry `auto: true` on their task.assigned event; the daily cap counts those.
  let auto = false

  if (input.task.role === 'REQUESTER') {
    // The person who asked does the work directly: never proposed, no load balancing, no assignee hint.
    // Without a recorded requester, the work item's owner stands in while still a project member;
    // otherwise the task is left for the PM.
    const [item] = await tx
      .select({ requesterId: workItems.requesterId, ownerId: workItems.ownerId })
      .from(workItems)
      .where(eq(workItems.id, input.workItemId))
    if (!item) throw new Error(`work item ${input.workItemId} missing`)
    if (item.requesterId) assigneeId = item.requesterId
    else if (await isMember(tx, input.projectId, item.ownerId)) assigneeId = item.ownerId
    else noCandidate = true
  } else if (input.executor !== 'ai') {
    const [proj] = await tx.select({ autonomy: projects.autonomy }).from(projects).where(eq(projects.id, input.projectId))
    const autoProject = proj?.autonomy === 'auto-assign'
    // The previous attempt's assignee keeps the task only while still a project member.
    const hint = input.assigneeHint && (await isMember(tx, input.projectId, input.assigneeHint)) ? input.assigneeHint : null
    if (autoProject && input.attempt > 1 && (await sentBackOften(tx, input))) {
      // G2: a task sent back again and again is proposed (to whoever did it last), not handed out silently.
      proposedAssigneeId = hint ?? (await pickAssignee(tx, input.projectId, input.task.role))
      if (proposedAssigneeId) {
        state = 'proposed'
        guard = 'repeated_rework'
      } else noCandidate = true
    } else if (hint) {
      assigneeId = hint
      auto = true
    } else {
      if (autoProject) {
        // Candidates already at today's cap are skipped. G6: with all of them capped, the least-loaded one is
        // proposed to the PM instead.
        await lockAutoAssign(tx)
        assigneeId = await pickAssignee(tx, input.projectId, input.task.role, { cap: ctx.dailyTaskCap })
        if (assigneeId) auto = true
        else if ((proposedAssigneeId = await pickAssignee(tx, input.projectId, input.task.role))) {
          state = 'proposed'
          guard = 'daily_cap'
        } else noCandidate = true
      } else {
        proposedAssigneeId = await pickAssignee(tx, input.projectId, input.task.role)
        if (proposedAssigneeId) state = 'proposed'
        else noCandidate = true
      }
    }
  }

  const [row] = await tx
    .insert(tasks)
    .values({
      workItemId: input.workItemId,
      projectId: input.projectId,
      stepKey: input.stepKey,
      templateTaskKey: input.task.key,
      attempt: input.attempt,
      type: input.task.type,
      role: input.task.role,
      executor: input.executor,
      feedback: input.feedback,
      state,
      assigneeId,
      proposedAssigneeId,
    })
    .returning({ id: tasks.id })
  const taskId = row!.id
  const base = { projectId: input.projectId, workItemId: input.workItemId, taskId }

  await recordEvent(ctx, { type: 'task.created', ...base, reason: guard ?? (noCandidate ? 'no_candidate' : null) })
  if (assigneeId) {
    await recordEvent(ctx, { type: 'task.assigned', ...base, payload: auto ? { assigneeId, auto: true } : { assigneeId } })
    await notifyTaskAssigned(ctx, {
      taskId,
      workItemId: input.workItemId,
      role: input.task.role,
      personId: assigneeId,
      taskTitle: input.task.title.th,
    })
  } else if (proposedAssigneeId) {
    await recordEvent(ctx, { type: 'task.proposed', ...base, reason: guard, payload: { proposedAssigneeId } })
    // A guard rail handed this assignment back: the PMs hear why (plain proposals show up in their to-do).
    if (guard) await notifyTaskProposed(ctx, { ...base, taskTitle: input.task.title.th, reason: guardText({ reason: guard }) })
  }

  // AI drafting runs after commit; a noAi project gets no AI calls at all (its AI tasks wait for a person).
  if (input.executor === 'ai' && input.task.capability === 'draft-text') {
    const [proj] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, input.projectId))
    if (proj && !proj.noAi) ctx.jobs.push({ name: 'draft-task', id: taskId })
  }
  // The Dev step started (or the code was sent back with feedback): create / refresh the GitLab issues, and
  // pull MR state (an MR may exist already, or a webhook delivery may have been lost).
  if (input.task.capability === 'code-change') {
    await queueIssueSync(ctx, input.workItemId, { withIssues: false })
    queueMrReconcile(ctx, input.workItemId)
  }
  return taskId
}

/** G2 on assignment: the task was sent back at least REPEATED_REWORK times in its current round. */
async function sentBackOften(tx: Tx, input: { workItemId: string; stepKey: string; task: TemplateTask }): Promise<boolean> {
  const [item] = await tx.select({ templateId: workItems.templateId }).from(workItems).where(eq(workItems.id, input.workItemId))
  const def = item ? await templateById(tx, item.templateId) : null
  const step = def?.steps.find((s) => s.key === input.stepKey)
  if (!step) return false
  return (await reworkCount(tx, input.workItemId, step, input.task.key)) >= REPEATED_REWORK
}

export async function isMember(tx: Tx, projectId: string, personId: string): Promise<boolean> {
  const [row] = await tx
    .select({ personId: projectMembers.personId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)))
  return !!row
}
