import { describe, expect, it } from 'vitest'
import type { WorkItemDetail } from '@yoda/shared'
import { daysUntil, reopenTargets, stepGroups } from '../app/utils/workItems'

type Step = WorkItemDetail['steps'][number]
const step = (key: string, status: Step['status']): Step => ({ key, name: { th: key, en: key }, status })

describe('reopenTargets', () => {
  it('offers the steps before the current one', () => {
    const steps = [step('intake', 'done'), step('dev', 'done'), step('qc', 'done'), step('close', 'current')]
    expect(reopenTargets(steps).map(s => s.key)).toEqual(['intake', 'dev', 'qc'])
  })
  it('offers nothing on the first step', () => {
    expect(reopenTargets([step('intake', 'current'), step('dev', 'pending')])).toEqual([])
  })
  it('offers nothing for a finished or cancelled item (no current step)', () => {
    expect(reopenTargets([step('intake', 'done'), step('dev', 'done')])).toEqual([])
    expect(reopenTargets([step('intake', 'pending'), step('dev', 'pending')])).toEqual([])
  })
})

type T = WorkItemDetail['tasks'][number]
let n = 0
const task = (stepKey: string, key: string, state: T['state'], attempt = 1): T => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  workItemId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  stepKey,
  templateTaskKey: key,
  attempt,
  type: 'human',
  role: 'DEV',
  executor: 'human',
  title: { th: key, en: key },
  instructions: { th: '', en: '' },
  feedback: null,
  state,
  assigneeId: null,
  assigneeName: null,
  proposedAssigneeId: null,
  proposedAssigneeName: null,
  result: null,
  aiStatus: null,
  aiFailReason: null,
  capability: null,
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
})

describe('stepGroups', () => {
  const steps = [step('intake', 'done'), step('dev', 'current'), step('qc', 'pending')]

  it('puts tasks under their step in step order and expands only the current step', () => {
    const tasks = [task('dev', 'impl', 'accepted'), task('intake', 'accept', 'accepted'), task('dev', 'review', 'open')]
    const groups = stepGroups(steps, tasks)
    expect(groups.map(g => [g.step.key, g.tasks.map(x => x.templateTaskKey), g.expanded])).toEqual([
      ['intake', ['accept'], false],
      ['dev', ['impl', 'review'], true],
      ['qc', [], false],
    ])
  })

  it('counts only the latest attempt of each task', () => {
    const tasks = [task('dev', 'impl', 'rejected', 1), task('dev', 'impl', 'accepted', 2), task('dev', 'review', 'in_progress')]
    const dev = stepGroups(steps, tasks)[1]!
    expect(dev.tasks).toHaveLength(3)
    expect([dev.done, dev.total]).toEqual([1, 2])
  })

  it('expands nothing when no step is current (done or cancelled items)', () => {
    const done = [step('intake', 'done'), step('dev', 'done')]
    expect(stepGroups(done, [task('dev', 'impl', 'accepted')]).some(g => g.expanded)).toBe(false)
  })
})

describe('daysUntil', () => {
  it('counts calendar days from today (negative once passed)', () => {
    expect(daysUntil('2026-12-09', '2026-11-25')).toBe(14)
    expect(daysUntil('2026-11-25', '2026-11-25')).toBe(0)
    expect(daysUntil('2026-11-23', '2026-11-25')).toBe(-2)
    expect(daysUntil(null, '2026-11-25')).toBeNull()
  })
})
