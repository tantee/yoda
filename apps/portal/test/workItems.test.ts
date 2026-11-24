import { describe, expect, it } from 'vitest'
import type { WorkItemDetail } from '@yoda/shared'
import { reopenTargets } from '../app/utils/workItems'

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
