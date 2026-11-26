export type StepStatus = 'done' | 'current' | 'pending'

/**
 * Where a work item is in its workflow: `n` is the 1-based current step (the step count when every step is done,
 * 0 before any started), `index` the current step's index or -1.
 */
export function stepProgress(steps: { status: StepStatus }[]): { n: number; total: number; index: number } {
  const index = steps.findIndex(s => s.status === 'current')
  const total = steps.length
  if (index >= 0) return { n: index + 1, total, index }
  const done = steps.filter(s => s.status === 'done').length
  return { n: done, total, index: -1 }
}
