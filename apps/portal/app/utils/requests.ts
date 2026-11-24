import type { MyRequest, Proposal, RequestStatus, TaskWithContext } from '@yoda/shared'

export function requestStatusColor(status: RequestStatus): string {
  switch (status) {
    case 'waiting_for_you': return 'warning'
    case 'in_progress':
    case 'submitted': return 'info'
    case 'done': return 'success'
    default: return 'default'
  }
}

/** The requester's answer tasks that belong to one of their requests. */
export function answersFor(request: Pick<MyRequest, 'workItemId'>, answers: TaskWithContext[]): TaskWithContext[] {
  return answers.filter(a => a.workItemId === request.workItemId)
}

/** The engine creates step_advance proposals without a summary: the portal supplies the wording. */
export function proposalFallbackKey(p: Pick<Proposal, 'kind' | 'summary'>): string | null {
  return p.kind === 'step_advance' && !p.summary.trim() ? 'todo.stepAdvance' : null
}
