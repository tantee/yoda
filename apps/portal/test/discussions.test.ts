import { describe, expect, it } from 'vitest'
import type { Discussion } from '@yoda/shared'
import { briefFailKey, sortDiscussions, voteSummary } from '../app/utils/discussions'

let n = 0
function d(over: Partial<Discussion>): Discussion {
  n++
  return {
    id: crypto.randomUUID(), projectId: null, projectName: null, workItemId: null, workItemTitle: null, taskId: null, stepKey: null,
    question: `q${n}`, details: '', priority: 'normal', state: 'open', brief: null, raisedById: crypto.randomUUID(), raisedByName: 'x',
    decision: null, decidedOptionKey: null, decidedById: null, decidedByName: null, decidedAt: null, agendaId: null,
    voteCounts: {}, myVote: null, responseCount: 0, createdAt: new Date(2026, 0, n).toISOString(), updatedAt: new Date(2026, 0, n).toISOString(),
    ...over,
  }
}

describe('sortDiscussions', () => {
  it('orders by priority urgent > high > normal > low, ties oldest first', () => {
    const low = d({ priority: 'low' })
    const normalOld = d({ priority: 'normal' })
    const urgent = d({ priority: 'urgent' })
    const normalNew = d({ priority: 'normal' })
    const high = d({ priority: 'high' })
    expect(sortDiscussions([low, normalNew, high, normalOld, urgent], 'priority')).toEqual([urgent, high, normalOld, normalNew, low])
  })
  it('does not mutate its input', () => {
    const list = [d({ priority: 'low' }), d({ priority: 'urgent' })]
    const copy = [...list]
    sortDiscussions(list, 'priority')
    expect(list).toEqual(copy)
  })
  it('created: newest first', () => {
    const a = d({})
    const b = d({})
    expect(sortDiscussions([a, b], 'created')).toEqual([b, a])
  })
  it('project: by project name, no project last', () => {
    const none = d({})
    const z = d({ projectName: 'Zeta' })
    const a = d({ projectName: 'Alpha' })
    expect(sortDiscussions([none, z, a], 'project')).toEqual([a, z, none])
  })
})

describe('voteSummary', () => {
  const brief = {
    context: '', recommendation: '', recommendedKey: 'b', source: 'ai' as const, status: 'ready' as const, failReason: null,
    options: [
      { key: 'a', title: 'ตัวเลือก ก', pros: '', cons: '' },
      { key: 'b', title: 'Option B', pros: '', cons: '' },
    ],
  }
  it('counts votes per option and flags the recommendation', () => {
    expect(voteSummary(d({ brief, voteCounts: { a: 2 } }))).toEqual([
      { key: 'a', title: 'ตัวเลือก ก', votes: 2, recommended: false },
      { key: 'b', title: 'Option B', votes: 0, recommended: true },
    ])
  })
  it('is empty without a brief', () => {
    expect(voteSummary(d({}))).toEqual([])
  })
})

describe('briefFailKey', () => {
  it('maps known reasons and falls back', () => {
    expect(briefFailKey('no_ai')).toBe('discussions.failReason.no_ai')
    expect(briefFailKey('budget_exceeded')).toBe('discussions.failReason.budget_exceeded')
    expect(briefFailKey('weird')).toBe('discussions.failReason.ai_failed')
    expect(briefFailKey(null)).toBe('discussions.failReason.ai_failed')
  })
})
