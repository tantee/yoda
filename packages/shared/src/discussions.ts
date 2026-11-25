import { z } from 'zod'
import { Priority } from './work.js'

const uuid = z.string().uuid()

export const DiscussionState = z.enum(['open', 'scheduled', 'decided', 'withdrawn'])
export type DiscussionState = z.infer<typeof DiscussionState>

export const DiscussionOption = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().trim().min(1).max(200),
  pros: z.string().max(4000).default(''),
  cons: z.string().max(4000).default(''),
})
export type DiscussionOption = z.infer<typeof DiscussionOption>

export const DiscussionBrief = z.object({
  context: z.string().max(20000),
  options: z.array(DiscussionOption).max(8),
  recommendation: z.string().max(4000),
  recommendedKey: z.string().nullable(),
  source: z.enum(['ai', 'person']),
  status: z.enum(['pending', 'ready', 'failed']),
  failReason: z.string().nullable(),
})
export type DiscussionBrief = z.infer<typeof DiscussionBrief>

export const Discussion = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  projectName: z.string().nullable(),
  workItemId: uuid.nullable(),
  workItemTitle: z.string().nullable(),
  taskId: uuid.nullable(),
  stepKey: z.string().nullable(),
  question: z.string(),
  details: z.string(),
  priority: Priority,
  state: DiscussionState,
  brief: DiscussionBrief.nullable(),
  raisedById: uuid,
  raisedByName: z.string(),
  decision: z.string().nullable(),
  decidedOptionKey: z.string().nullable(),
  decidedById: uuid.nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  agendaId: uuid.nullable(),
  voteCounts: z.record(z.number().int()),
  myVote: z.string().nullable(),
  responseCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Discussion = z.infer<typeof Discussion>

export const DiscussionCreate = z
  .object({
    projectId: uuid.optional(),
    workItemId: uuid.optional(),
    taskId: uuid.optional(),
    question: z.string().trim().min(1).max(500),
    details: z.string().max(20000).default(''),
    priority: Priority.default('normal'),
    options: z.array(DiscussionOption).max(8).default([]),
    requestBrief: z.boolean().default(true),
  })
  .refine((v) => !v.taskId || !!v.workItemId, { message: 'taskId requires workItemId', path: ['taskId'] })
export type DiscussionCreate = z.infer<typeof DiscussionCreate>

export const DiscussionResponseKind = z.enum(['opinion', 'vote'])
export type DiscussionResponseKind = z.infer<typeof DiscussionResponseKind>

export const DiscussionResponse = z.object({
  id: uuid,
  discussionId: uuid,
  authorId: uuid,
  authorName: z.string(),
  kind: DiscussionResponseKind,
  optionKey: z.string().nullable(),
  text: z.string(),
  createdAt: z.string(),
})
export type DiscussionResponse = z.infer<typeof DiscussionResponse>

export const DiscussionResponseCreate = z
  .object({
    kind: DiscussionResponseKind,
    optionKey: z.string().optional(),
    text: z.string().trim().max(10000).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'vote' && !v.optionKey) ctx.addIssue({ code: 'custom', path: ['optionKey'], message: 'a vote needs an option' })
    if (v.kind === 'opinion' && !v.text) ctx.addIssue({ code: 'custom', path: ['text'], message: 'an opinion needs text' })
  })
export type DiscussionResponseCreate = z.infer<typeof DiscussionResponseCreate>

export const DiscussionDecide = z.object({
  decision: z.string().trim().min(1).max(10000),
  optionKey: z.string().optional(),
})
export type DiscussionDecide = z.infer<typeof DiscussionDecide>

export const DiscussionWithdraw = z.object({ reason: z.string().trim().min(1).max(2000) })
export type DiscussionWithdraw = z.infer<typeof DiscussionWithdraw>

export const DiscussionBriefEdit = DiscussionBrief.pick({ context: true, options: true, recommendation: true, recommendedKey: true })
export type DiscussionBriefEdit = z.infer<typeof DiscussionBriefEdit>

export const Agenda = z.object({
  id: uuid,
  title: z.string(),
  meetingAt: z.string(),
  createdById: uuid,
  items: z.array(
    z.object({
      discussionId: uuid,
      position: z.number().int(),
      question: z.string(),
      projectName: z.string().nullable(),
      state: DiscussionState,
      priority: Priority,
    }),
  ),
  createdAt: z.string(),
})
export type Agenda = z.infer<typeof Agenda>

export const AgendaCreate = z.object({
  title: z.string().trim().min(1).max(200),
  meetingAt: z.string().datetime({ offset: true }),
})
export type AgendaCreate = z.infer<typeof AgendaCreate>

export const AgendaItemsPut = z.object({ discussionIds: z.array(uuid).max(50) })
export type AgendaItemsPut = z.infer<typeof AgendaItemsPut>
