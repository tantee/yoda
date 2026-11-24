import { z } from 'zod'
import { ProjectRole } from './projects.js'
import { Attachment } from './knowledge.js'
import { ActorKind } from './actors.js'
import { Proposal } from './proposals.js'

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
export const Priority = z.enum(['low', 'normal', 'high', 'urgent'])
export type Priority = z.infer<typeof Priority>
export const WorkItemState = z.enum(['active', 'done', 'cancelled'])
export type WorkItemState = z.infer<typeof WorkItemState>

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
})
export type TaskWithContext = z.infer<typeof TaskWithContext>

export const Todo = z.object({
  tasks: z.array(TaskWithContext),
  confirmations: z.array(TaskWithContext),
  proposals: z.array(Proposal),
})
export type Todo = z.infer<typeof Todo>

export const TaskAssign = z.object({ personId: uuid })
export type TaskAssign = z.infer<typeof TaskAssign>

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
  ownerId: uuid,
  ownerName: z.string(),
  requesterId: uuid.nullable(),
  requesterName: z.string().nullable(),
  state: WorkItemState,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WorkItem = z.infer<typeof WorkItem>

export const EventType = z.enum([
  'work_item.created', 'work_item.step_advanced', 'work_item.done', 'work_item.cancelled',
  'task.created', 'task.proposed', 'task.assigned', 'task.unassigned', 'task.started', 'task.accepted', 'task.rejected',
  'ai.drafted', 'ai.failed', 'ai.retried', 'ai.budget_warning', 'ai.budget_exceeded',
  'knowledge.created', 'knowledge.updated', 'knowledge.confirmed',
  'proposal.created', 'proposal.accepted', 'proposal.rejected', 'proposal.superseded', 'work_item.priority_changed',
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
