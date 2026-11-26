import type { WorkItemDetail } from '@yoda/shared'

type Step = WorkItemDetail['steps'][number]

/** Steps an active work item may be reopened to: those before its current step (none when there is no current step). */
export function reopenTargets(steps: Step[]): Step[] {
  const current = steps.findIndex(s => s.status === 'current')
  return current > 0 ? steps.slice(0, current) : []
}

type Task = WorkItemDetail['tasks'][number]

export interface StepGroup {
  step: Step
  /** Every attempt, in the detail's order. */
  tasks: Task[]
  /** Accepted among the latest attempts, out of the latest attempts. */
  done: number
  total: number
  /** Only the current step opens by default. */
  expanded: boolean
}

/** Tasks grouped by workflow step (proposal §8.2 work item), with progress over each task's latest attempt. */
export function stepGroups(steps: Step[], tasks: Task[]): StepGroup[] {
  return steps.map((step) => {
    const mine = tasks.filter(x => x.stepKey === step.key)
    const latest = new Map<string, Task>()
    for (const x of mine) {
      const seen = latest.get(x.templateTaskKey)
      if (!seen || x.attempt > seen.attempt) latest.set(x.templateTaskKey, x)
    }
    const current = [...latest.values()]
    return {
      step,
      tasks: mine,
      done: current.filter(x => x.state === 'accepted').length,
      total: current.length,
      expanded: step.status === 'current',
    }
  })
}

/** Calendar days from `today` to a target date (both `YYYY-MM-DD`); negative once it has passed. */
export function daysUntil(targetDate: string | null, today: string): number | null {
  if (!targetDate) return null
  return Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}
