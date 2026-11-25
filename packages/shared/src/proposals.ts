import { z } from 'zod'
import { ActorKind } from './actors.js'

const uuid = z.string().uuid()

export const ProposalKind = z.enum(['step_advance', 'create_work_item', 'priority_change', 'raise_discussion'])
export type ProposalKind = z.infer<typeof ProposalKind>
export const ProposalState = z.enum(['pending', 'accepted', 'rejected', 'superseded'])
export type ProposalState = z.infer<typeof ProposalState>

/**
 * Why an `auto-assign` project handed a decision back to the PM: on a `step_advance` proposal's payload
 * (`guard`, `guardDetail`), and as the reason of `task.created` / `task.proposed` events for assignments.
 */
export const GuardReason = z.enum([
  'rework',
  'repeated_rework',
  'ai_low_confidence',
  'high_priority',
  'ai_budget',
  'daily_cap',
  'no_assignee',
  'requester_changes',
])
export type GuardReason = z.infer<typeof GuardReason>

export const Proposal = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  workItemId: uuid.nullable(),
  kind: ProposalKind,
  summary: z.string(),
  reason: z.string(),
  /** `guard?: GuardReason` and `guardDetail?: string` when a guard rail made this a proposal. */
  payload: z.record(z.unknown()),
  state: ProposalState,
  createdByKind: ActorKind,
  onBehalfOfId: uuid.nullable(),
  decidedById: uuid.nullable(),
  decidedByName: z.string().nullable(),
  /** `create_work_item`: the display name of the person named as requester in the payload (null when none). */
  requesterName: z.string().nullable().default(null),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
})
export type Proposal = z.infer<typeof Proposal>

export const ProposalDecision = z.object({
  decision: z.enum(['accept', 'reject']),
  note: z.string().max(2000).optional(),
  /** Only used when accepting a create_work_item proposal whose payload names no project. */
  projectId: uuid.optional(),
})
export type ProposalDecision = z.infer<typeof ProposalDecision>
