import { describe, expect, it } from 'vitest'
import type { MyRequest, RequestEvent, TaskWithContext } from '@yoda/shared'
import {
  answersByRequest,
  answersFor,
  groupRequests,
  plainSteps,
  proposalFallbackKey,
  requestEventText,
  requesterStepKey,
  requesterTaskKind,
  taskViewFor,
} from '../app/utils/requests'

describe('answersFor', () => {
  it('keeps only answer tasks of the given request', () => {
    const a = { id: 'a', workItemId: 'w1' } as TaskWithContext
    const b = { id: 'b', workItemId: 'w2' } as TaskWithContext
    expect(answersFor({ workItemId: 'w1' } as MyRequest, [a, b])).toEqual([a])
  })
})

describe('proposalFallbackKey', () => {
  it('names system step advances that carry no summary', () => {
    expect(proposalFallbackKey({ kind: 'step_advance', summary: '' })).toBe('todo.stepAdvance')
    expect(proposalFallbackKey({ kind: 'step_advance', summary: ' ' })).toBe('todo.stepAdvance')
  })
  it('keeps written summaries', () => {
    expect(proposalFallbackKey({ kind: 'step_advance', summary: 'Move on' })).toBeNull()
    expect(proposalFallbackKey({ kind: 'create_work_item', summary: '' })).toBeNull()
  })
})

describe('taskViewFor', () => {
  const staff = { isStaff: true }
  const requester = { isStaff: false }
  it('staff who can see the project get the staff view', () => {
    expect(taskViewFor(staff, { viewerIsRequester: false })).toEqual({ requesterView: false, back: '/todo' })
  })
  it('a staff requester outside the project gets the requester view, back to their to-do', () => {
    expect(taskViewFor(staff, { viewerIsRequester: true })).toEqual({ requesterView: true, back: '/todo' })
  })
  it('requesters always get the requester view', () => {
    expect(taskViewFor(requester, { viewerIsRequester: true })).toEqual({ requesterView: true, back: '/answers' })
    expect(taskViewFor(requester, null)).toEqual({ requesterView: true, back: '/answers' })
  })
  it('staff default to the staff view before the task loads', () => {
    expect(taskViewFor(staff, null)).toEqual({ requesterView: false, back: '/todo' })
  })
})

describe('requester glossary and grouping', () => {
  const req = (workItemId: string, status: MyRequest['status']) => ({ workItemId, status }) as MyRequest
  it('maps the known workflow steps to plain words and leaves others to the step name', () => {
    for (const k of ['intake', 'ba', 'sa', 'dev', 'qc', 'close']) expect(requesterStepKey(k)).toBe(`requests.step.${k}`)
    expect(requesterStepKey('custom')).toBeNull()
    expect(requesterStepKey(null)).toBeNull()
  })
  it('names a requester task by what it asks for', () => {
    expect(requesterTaskKind({ type: 'approval' })).toBe('delivery')
    expect(requesterTaskKind({ type: 'human' })).toBe('question')
    expect(requesterTaskKind({ type: 'review' })).toBe('delivery')
  })
  it('splits requests into waiting for you, in progress and finished, keeping their order', () => {
    const list = [req('a', 'in_progress'), req('b', 'waiting_for_you'), req('c', 'done'), req('d', 'submitted'), req('e', 'cancelled'), req('f', 'waiting_for_you')]
    const g = groupRequests(list)
    expect(g.waiting.map(r => r.workItemId)).toEqual(['b', 'f'])
    expect(g.active.map(r => r.workItemId)).toEqual(['a', 'd'])
    expect(g.done.map(r => r.workItemId)).toEqual(['c', 'e'])
  })
  it('groups answers by request, oldest request question first', () => {
    const a = (id: string, workItemId: string, createdAt: string) => ({ id, workItemId, workItemTitle: workItemId.toUpperCase(), createdAt }) as TaskWithContext
    const groups = answersByRequest([a('1', 'w2', '2026-11-02'), a('2', 'w1', '2026-11-01'), a('3', 'w2', '2026-11-03')])
    expect(groups.map(g => [g.workItemId, g.title, g.answers.map(x => x.id)])).toEqual([
      ['w1', 'W1', ['2']],
      ['w2', 'W2', ['1', '3']],
    ])
  })
})

describe('requestEventText', () => {
  const ev = (over: Partial<RequestEvent>): RequestEvent => ({ kind: 'received', at: '2026-11-25T07:05:00Z', stepKey: null, stepName: null, date: null, byYou: false, ...over })
  const step = (key: string | null, name: string) => (key ? `plain:${key}` : name)
  const date = (d: string) => `D${d}`
  it('words step moves with the plain step label', () => {
    expect(requestEventText(ev({ kind: 'step', stepKey: 'dev', stepName: { th: 'พัฒนา', en: 'Development' } }), step, date, 'th'))
      .toEqual({ key: 'requests.event.step', params: { step: 'plain:dev' } })
    expect(requestEventText(ev({ kind: 'reopened', stepKey: 'x', stepName: { th: 'ขั้นพิเศษ', en: 'Special' } }), () => 'ขั้นพิเศษ', date, 'th'))
      .toEqual({ key: 'requests.event.reopened', params: { step: 'ขั้นพิเศษ' } })
  })
  it('words the expected date, or its removal', () => {
    expect(requestEventText(ev({ kind: 'expected_date', date: '2026-12-09' }), step, date, 'th')).toEqual({ key: 'requests.event.expected_date', params: { date: 'D2026-12-09' } })
    expect(requestEventText(ev({ kind: 'expected_date', date: null }), step, date, 'th')).toEqual({ key: 'requests.event.expected_date_cleared', params: {} })
  })
  it('uses the kind for everything else', () => {
    expect(requestEventText(ev({ kind: 'question' }), step, date, 'th')).toEqual({ key: 'requests.event.question', params: {} })
  })
  it('words answers and acceptance by the requester or by someone else', () => {
    expect(requestEventText(ev({ kind: 'answered', byYou: true }), step, date, 'th').key).toBe('requests.event.answered')
    expect(requestEventText(ev({ kind: 'accepted', byYou: true }), step, date, 'th').key).toBe('requests.event.accepted')
    expect(requestEventText(ev({ kind: 'answered', byYou: false }), step, date, 'th').key).toBe('requests.event.answeredOther')
    expect(requestEventText(ev({ kind: 'accepted', byYou: false }), step, date, 'th').key).toBe('requests.event.acceptedOther')
  })
})

describe('plainSteps', () => {
  it('names the known steps in requester words and keeps the step name otherwise', () => {
    const t = (k: string) => `T:${k}`
    const steps = [
      { key: 'intake', name: { th: 'รับเรื่อง', en: 'Intake' }, status: 'done' as const },
      { key: 'custom', name: { th: 'พิเศษ', en: 'Special' }, status: 'current' as const },
    ]
    expect(plainSteps(steps, t)).toEqual([
      { key: 'intake', name: 'T:requests.step.intake', status: 'done' },
      { key: 'custom', name: { th: 'พิเศษ', en: 'Special' }, status: 'current' },
    ])
  })
})
