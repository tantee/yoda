import type { TaskExecutor, TemplateTask } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { Tx } from '../db/client.js'
import { projectMembers, projects, tasks, workItems } from '../db/schema.js'
import { pickAssignee } from './assign.js'
import { recordEvent, type WorkCtx } from './context.js'

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
    // The previous attempt's assignee keeps the task only while still a project member.
    if (input.assigneeHint && (await isMember(tx, input.projectId, input.assigneeHint))) {
      assigneeId = input.assigneeHint
    } else {
      const candidate = await pickAssignee(tx, input.projectId, input.task.role)
      if (!candidate) {
        noCandidate = true
      } else {
        const [proj] = await tx.select({ autonomy: projects.autonomy }).from(projects).where(eq(projects.id, input.projectId))
        if (proj?.autonomy === 'auto-assign') assigneeId = candidate
        else {
          state = 'proposed'
          proposedAssigneeId = candidate
        }
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

  await recordEvent(ctx, { type: 'task.created', ...base, reason: noCandidate ? 'no_candidate' : null })
  if (assigneeId) await recordEvent(ctx, { type: 'task.assigned', ...base, payload: { assigneeId } })
  else if (proposedAssigneeId) await recordEvent(ctx, { type: 'task.proposed', ...base, payload: { proposedAssigneeId } })

  // AI drafting runs after commit; a noAi project gets no AI calls at all (its AI tasks wait for a person).
  if (input.executor === 'ai' && input.task.capability === 'draft-text') {
    const [proj] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, input.projectId))
    if (proj && !proj.noAi) ctx.jobs.push({ name: 'draft-task', id: taskId })
  }
  return taskId
}

export async function isMember(tx: Tx, projectId: string, personId: string): Promise<boolean> {
  const [row] = await tx
    .select({ personId: projectMembers.personId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)))
  return !!row
}
