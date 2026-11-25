import type { Me, MyRequest, Proposal, TaskWithContext } from '@yoda/shared'

/** The requester's answer tasks that belong to one of their requests. */
export function answersFor(request: Pick<MyRequest, 'workItemId'>, answers: TaskWithContext[]): TaskWithContext[] {
  return answers.filter(a => a.workItemId === request.workItemId)
}

/** The engine creates step_advance proposals without a summary: the portal supplies the wording. */
export function proposalFallbackKey(p: Pick<Proposal, 'kind' | 'summary'>): string | null {
  return p.kind === 'step_advance' && !p.summary.trim() ? 'todo.stepAdvance' : null
}

/**
 * Whether the task page shows the trimmed requester view (no project / work item links or staff controls,
 * uploads to the viewer's own conversation): for requesters, and for staff who see the task only as its
 * requester (core's `viewerIsRequester`, e.g. a staff requester outside the project). The back link goes to
 * the viewer's home list.
 */
export function taskViewFor(
  me: Pick<Me, 'isStaff'> | null | undefined,
  task: Pick<TaskWithContext, 'viewerIsRequester'> | null | undefined,
): { requesterView: boolean; back: '/todo' | '/answers' } {
  const isStaff = !!me?.isStaff
  return { requesterView: !isStaff || !!task?.viewerIsRequester, back: isStaff ? '/todo' : '/answers' }
}
