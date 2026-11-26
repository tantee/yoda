import { describe, expect, it } from 'vitest'
import type { Discussion, DiscussionResponse } from '@yoda/shared'
import { briefFailKey, sortDiscussions, voteShares, voteSummary, votersByOption } from '../app/utils/discussions'

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

describe('voteShares', () => {
  const brief = (keys: string[], recommendedKey: string | null = null) => ({
    context: '', recommendation: '', recommendedKey, source: 'ai' as const, status: 'ready' as const, failReason: null,
    options: keys.map(k => ({ key: k, title: `T${k}`, pros: `P${k}`, cons: `C${k}` })),
  })
  it('gives each option its votes and rounded share, with my vote, the recommendation and the decision marked', () => {
    const r = voteShares(d({ brief: brief(['a', 'b', 'c'], 'c'), voteCounts: { a: 1, c: 2 }, myVote: 'c', decidedOptionKey: 'a' }))
    expect(r.total).toBe(3)
    expect(r.options.map(o => [o.key, o.votes, o.percent, o.recommended, o.mine, o.decided])).toEqual([
      ['a', 1, 33, false, false, true],
      ['b', 0, 0, false, false, false],
      ['c', 2, 67, true, true, false],
    ])
    expect(r.options[0]).toMatchObject({ title: 'Ta', pros: 'Pa', cons: 'Ca' })
  })
  it('is all zero without votes and empty without a brief', () => {
    expect(voteShares(d({ brief: brief(['a']) })).options[0]!.percent).toBe(0)
    expect(voteShares(d({}))).toEqual({ total: 0, options: [] })
  })
  it('ignores votes for options no longer in the brief', () => {
    expect(voteShares(d({ brief: brief(['a']), voteCounts: { a: 1, gone: 3 } })).options[0]!.percent).toBe(100)
  })
})

describe('votersByOption', () => {
  const r = (authorId: string, kind: 'vote' | 'opinion', optionKey: string | null): DiscussionResponse => ({
    id: crypto.randomUUID(), discussionId: 'd', authorId, authorName: `N${authorId}`, kind, optionKey, text: '', createdAt: '2026-11-25T00:00:00Z',
  })
  it('counts each person once, at their latest vote, and skips opinions', () => {
    expect(votersByOption([r('1', 'vote', 'a'), r('2', 'vote', 'a'), r('1', 'opinion', null), r('1', 'vote', 'b')])).toEqual({ a: ['N2'], b: ['N1'] })
    expect(votersByOption([])).toEqual({})
  })
})
