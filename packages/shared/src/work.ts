import { z } from 'zod'
import { ProjectRole } from './projects.js'
import { Attachment } from './knowledge.js'
import { ActorKind } from './actors.js'
import { Proposal } from './proposals.js'
import { TaskRunSummary } from './runners.js'

export { ActorKind }

const uuid = z.string().uuid()
const keyRe = /^[a-z0-9-]+$/

export const LocalizedText = z.object({ th: z.string().min(1), en: z.string().min(1) })
export type LocalizedText = z.infer<typeof LocalizedText>

export const TaskType = z.enum(['ai', 'human', 'review', 'approval'])
export type TaskType = z.infer<typeof TaskType>
export const TaskExecutor = z.enum(['ai', 'human'])
export type TaskExecutor = z.infer<typeof TaskExecutor>
// `submitted` is reserved for plan 7 runner results; plan 2 submits resolve immediately.
export const TaskState = z.enum(['proposed', 'open', 'in_progress', 'submitted', 'accepted', 'rejected'])
export type TaskState = z.infer<typeof TaskState>
/** States in which a task is still in play (not yet accepted or rejected). */
export const ACTIVE_TASK_STATES = ['proposed', 'open', 'in_progress', 'submitted'] as const satisfies readonly TaskState[]
export const Priority = z.enum(['low', 'normal', 'high', 'urgent'])
export type Priority = z.infer<typeof Priority>
export const WorkItemState = z.enum(['active', 'done', 'cancelled'])
export type WorkItemState = z.infer<typeof WorkItemState>

/** A calendar date, `YYYY-MM-DD` (a real date: `2026-02-30` is refused). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, 'invalid date')
export type IsoDate = z.infer<typeof IsoDate>

export const TaskCapability = z.enum(['draft-text', 'analyze-repo', 'code-change', 'run-tests'])
export type TaskCapability = z.infer<typeof TaskCapability>

/** Project roles plus REQUESTER: the person who asked for the work. */
export const TemplateRole = z.enum([...ProjectRole.options, 'REQUESTER'])
export type TemplateRole = z.infer<typeof TemplateRole>

export const TemplateTask = z.object({
  key: z.string().regex(keyRe),
  type: TaskType,
  role: TemplateRole,
  title: LocalizedText,
  instructions: LocalizedText,
  dependsOn: z.array(z.string()).default([]),
  capability: TaskCapability.optional(),
})
export type TemplateTask = z.infer<typeof TemplateTask>

export const TemplateStep = z.object({
  key: z.string().regex(keyRe),
  name: LocalizedText,
  tasks: z.array(TemplateTask).min(1),
})
export type TemplateStep = z.infer<typeof TemplateStep>

export const WorkflowTemplateDef = z.object({
  key: z.string().regex(keyRe),
  name: LocalizedText,
  steps: z.array(TemplateStep).min(1),
})
export type WorkflowTemplateDef = z.infer<typeof WorkflowTemplateDef>

/** Executor is derived from the task type: only `ai` tasks run on AI. */
export function executorFor(type: TaskType): TaskExecutor {
  return type === 'ai' ? 'ai' : 'human'
}

/** Returns a list of problems; empty means the template is valid. */
export function validateTemplate(def: WorkflowTemplateDef): string[] {
  const problems: string[] = []
  const stepKeys = new Set<string>()
  const taskKeys = new Set<string>()
  for (const step of def.steps) {
    if (stepKeys.has(step.key)) problems.push(`duplicate step key: ${step.key}`)
    stepKeys.add(step.key)
    const earlierInStep = new Set<string>()
    step.tasks.forEach((task, i) => {
      if (taskKeys.has(task.key)) problems.push(`duplicate task key: ${task.key}`)
      taskKeys.add(task.key)
      for (const dep of task.dependsOn) {
        if (!earlierInStep.has(dep)) {
          problems.push(`task ${task.key} depends on ${dep}, which is not an earlier task in step ${step.key}`)
        }
      }
      if ((task.type === 'review' || task.type === 'approval') && task.dependsOn.length === 0 && i > 0) {
        problems.push(`${task.type} task ${task.key} must depend on an earlier task unless it is first in step ${step.key}`)
      }
      if (task.type === 'ai' && !task.capability) problems.push(`ai task ${task.key} must declare a capability`)
      if (task.type !== 'ai' && task.capability) problems.push(`task ${task.key} must not declare a capability (only ai tasks may)`)
      if (task.role === 'REQUESTER' && task.type !== 'human' && task.type !== 'approval') {
        problems.push(`REQUESTER task ${task.key} must be a human or approval task`)
      }
      earlierInStep.add(task.key)
    })
  }
  return problems
}

export const WorkflowTemplateSummary = z.object({
  key: z.string(),
  version: z.number().int(),
  name: LocalizedText,
  steps: z.array(z.object({ key: z.string(), name: LocalizedText })),
})
export type WorkflowTemplateSummary = z.infer<typeof WorkflowTemplateSummary>

export const TaskResult = z.object({
  text: z.string().max(50000).default(''),
  decision: z.enum(['approve', 'changes']).optional(),
  /** Attachments of the task's project, linked to the task on submit. */
  attachmentIds: z.array(uuid).max(20).default([]),
  /** AI drafts: the drafter's own confidence note (missing note = high, nothing missing). */
  confidence: z.enum(['high', 'low']).optional(),
  missing: z.array(z.string()).optional(),
})
export type TaskResult = z.infer<typeof TaskResult>

export const Task = z.object({
  id: uuid,
  workItemId: uuid,
  projectId: uuid,
  stepKey: z.string(),
  templateTaskKey: z.string(),
  attempt: z.number().int().min(1),
  type: TaskType,
  role: TemplateRole,
  executor: TaskExecutor,
  title: LocalizedText,
  instructions: LocalizedText,
  feedback: z.string().nullable(),
  state: TaskState,
  assigneeId: uuid.nullable(),
  assigneeName: z.string().nullable(),
  proposedAssigneeId: uuid.nullable(),
  proposedAssigneeName: z.string().nullable(),
  result: TaskResult.nullable(),
  /** 'drafting' while an AI draft is pending, 'failed' (see aiFailReason) when it needs a person; null otherwise. */
  aiStatus: z.enum(['drafting', 'failed']).nullable(),
  aiFailReason: z.string().nullable(),
  /** The template task's capability (AI tasks only; null for people's tasks). */
  capability: TaskCapability.nullable(),
  /** Work item detail and task detail (staff only): the task's latest runner run, null when none. Absent elsewhere. */
  run: TaskRunSummary.nullable().optional(),
  /** Alongside `run` (staff only): the task waits on a runner's question (an undecided parked discussion). */
  parked: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Task = z.infer<typeof Task>

export const TaskInput = z.object({
  templateTaskKey: z.string(),
  title: LocalizedText,
  executor: TaskExecutor,
  result: TaskResult,
  attachments: z.array(Attachment),
})
export type TaskInput = z.infer<typeof TaskInput>

export const TaskWithContext = Task.extend({
  workItemTitle: z.string(),
  workItemPriority: Priority,
  projectName: z.string(),
  inputs: z.array(TaskInput),
  attachments: z.array(Attachment),
  /**
   * The viewer sees this task only as its requester (a requester, or staff outside the project): the portal
   * shows the trimmed requester view (no project / work item links, uploads go to their own conversation).
   */
  viewerIsRequester: z.boolean(),
})
export type TaskWithContext = z.infer<typeof TaskWithContext>

export const TaskAssign = z.object({ personId: uuid })
export type TaskAssign = z.infer<typeof TaskAssign>

/** POST /work-items/:id/reopen: send the item back to an earlier step of its template. */
export const WorkItemReopen = z.object({ stepKey: z.string().min(1) })
export type WorkItemReopen = z.infer<typeof WorkItemReopen>

export const WorkItemCreate = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(''),
  templateKey: z.string(),
  priority: Priority.default('normal'),
  ownerId: uuid.optional(),
  requesterId: uuid.optional(),
})
export type WorkItemCreate = z.infer<typeof WorkItemCreate>

export const WorkItem = z.object({
  id: uuid,
  projectId: uuid,
  title: z.string(),
  description: z.string(),
  templateKey: z.string(),
  templateVersion: z.number().int(),
  currentStepKey: z.string().nullable(),
  priority: Priority,
  /** Optional target date (`YYYY-MM-DD`, Asia/Bangkok), set by the PM or owner; overdue once it has passed. */
  targetDate: IsoDate.nullable(),
  ownerId: uuid,
  ownerName: z.string(),
  requesterId: uuid.nullable(),
  requesterName: z.string().nullable(),
  state: WorkItemState,
  /**
   * Active, every task of the current step accepted, a next step exists and no step_advance proposal is
   * pending (e.g. the PM rejected it): a PM may advance it with POST /work-items/:id/advance.
   */
  awaitingAdvance: z.boolean(),
  /** Open or scheduled discussions linked to this item (they block its step from advancing). */
  openDiscussions: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkItem = z.infer<typeof WorkItem>

/** PATCH /work-items/:id (the PM or the owner). `targetDate: null` clears it. */
export const WorkItemPatch = z
  .object({
    targetDate: IsoDate.nullable().optional(),
  })
  .strict()
export type WorkItemPatch = z.infer<typeof WorkItemPatch>

export const Todo = z.object({
  tasks: z.array(TaskWithContext),
  confirmations: z.array(TaskWithContext),
  proposals: z.array(Proposal),
  /** Work items (where the caller decides, as for confirmations) whose finished step waits to be advanced. */
  awaitingAdvance: z.array(WorkItem),
})
export type Todo = z.infer<typeof Todo>

export const EventType = z.enum([
  'work_item.created', 'work_item.step_advanced', 'work_item.done', 'work_item.cancelled',
  /** A PM sent the item back to an earlier step (payload `{ from, to }`). */
  'work_item.reopened',
  'task.created', 'task.proposed', 'task.assigned', 'task.unassigned', 'task.started', 'task.accepted', 'task.rejected',
  'ai.drafted', 'ai.failed', 'ai.retried', 'ai.budget_warning', 'ai.budget_exceeded',
  'knowledge.created', 'knowledge.updated', 'knowledge.confirmed',
  'proposal.created', 'proposal.accepted', 'proposal.rejected', 'proposal.superseded', 'work_item.priority_changed',
  /** The PM or owner set or cleared the target date (payload `{ from, to }`, `YYYY-MM-DD` or null). */
  'work_item.target_date_changed',
  'gitlab.issue_synced', 'gitlab.issue_sync_failed', 'gitlab.mr_opened', 'gitlab.mr_merged', 'gitlab.mr_closed', 'gitlab.pipeline', 'gitlab.note',
  'run.claimed', 'run.progress', 'run.succeeded', 'run.failed', 'run.expired', 'run.parked', 'run.released', 'gitlab.mr_requested',
  /** The weekly AI summary was written (payload `{ week, entryId, version }`) or skipped (`reason`, payload `{ week }`). */
  'status.weekly_summary', 'status.weekly_summary_skipped',
  'discussion.raised', 'discussion.brief_ready', 'discussion.brief_failed', 'discussion.scheduled', 'discussion.decided', 'discussion.withdrawn',
  /** Live-only (never stored in `events`): someone gave an opinion or voted on a discussion. */
  'discussion.responded',
  /** Live-only (never stored in `events`): a runner's heartbeat on a task (throttled), so open pages refresh the run. */
  'run.heartbeat',
  /** Live-only (never stored in `events`): a message was posted in `conversationId`. */
  'message.created',
  /** Live-only (never stored in `events`): a notification was created for `personId`. */
  'notification.created',
])
export type EventType = z.infer<typeof EventType>

export const EventEntry = z.object({
  id: uuid,
  type: EventType,
  actorKind: ActorKind,
  actorId: uuid.nullable(),
  actorName: z.string().nullable(),
  taskId: uuid.nullable(),
  reason: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
})
export type EventEntry = z.infer<typeof EventEntry>

export const WorkItemDetail = WorkItem.extend({
  steps: z.array(z.object({ key: z.string(), name: LocalizedText, status: z.enum(['done', 'current', 'pending']) })),
  tasks: z.array(Task),
  events: z.array(EventEntry),
})
export type WorkItemDetail = z.infer<typeof WorkItemDetail>

export const LiveEvent = z.object({
  type: EventType,
  projectId: uuid.nullable(),
  workItemId: uuid.nullable(),
  taskId: uuid.nullable(),
  conversationId: uuid.nullable(),
  /** Set for person-addressed events such as notifications. */
  personId: uuid.nullable(),
})
export type LiveEvent = z.infer<typeof LiveEvent>

export const RequestStatus = z.enum(['submitted', 'in_progress', 'waiting_for_you', 'done', 'cancelled'])
export type RequestStatus = z.infer<typeof RequestStatus>

export const MyRequest = z.object({
  workItemId: uuid,
  title: z.string(),
  projectName: z.string(),
  status: RequestStatus,
  currentStepName: LocalizedText.nullable(),
  updatedAt: z.string(),
})
export type MyRequest = z.infer<typeof MyRequest>
