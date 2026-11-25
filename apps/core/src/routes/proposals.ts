import { ProposalDecision, ProposalState } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { invalidState, requireStaff } from '../auth/plugin.js'
import { decideProposal, getProposal, listProposals } from '../proposals/service.js'
import { runWork } from '../work/context.js'

const IdParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({ projectId: z.string().uuid().optional(), state: ProposalState.optional() })

export function proposalRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/proposals', async (request) => {
    requireStaff(request)
    return listProposals(db(), request.me, ListQuery.parse(request.query))
  })

  /** → the decided `Proposal`. 409 `invalid_state` when no longer pending, or when superseded on accept. */
  app.post('/proposals/:id/decide', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const decision = ProposalDecision.parse(request.body)
    const me = request.me
    const { superseded } = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) =>
      decideProposal(ctx, me, id, decision),
    )
    // The supersede is committed; the caller learns its accept did not apply.
    if (superseded) throw invalidState()
    return getProposal(db(), id)
  })
}
