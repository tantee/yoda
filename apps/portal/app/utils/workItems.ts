import type { WorkItemDetail } from '@yoda/shared'

type Step = WorkItemDetail['steps'][number]

/** Steps an active work item may be reopened to: those before its current step (none when there is no current step). */
export function reopenTargets(steps: Step[]): Step[] {
  const current = steps.findIndex(s => s.status === 'current')
  return current > 0 ? steps.slice(0, current) : []
}
