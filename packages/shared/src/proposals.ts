import { z } from 'zod'
import { ActorKind } from './actors.js'

const uuid = z.string().uuid()

export const ProposalKind = z.enum(['step_advance', 'create_work_item', 'priority_change'])
export type ProposalKind = z.infer<typeof ProposalKind>
export const ProposalState = z.enum(['pending', 'accepted', 'rejected', 'superseded'])
export type ProposalState = z.infer<typeof ProposalState>

export const Proposal = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  workItemId: uuid.nullable(),
  kind: ProposalKind,
  summary: z.string(),
  reason: z.string(),
  payload: z.record(z.unknown()),
  state: ProposalState,
  createdByKind: ActorKind,
  onBehalfOfId: uuid.nullable(),
  decidedById: uuid.nullable(),
  decidedByName: z.string().nullable(),
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
