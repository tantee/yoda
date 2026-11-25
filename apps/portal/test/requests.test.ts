import { describe, expect, it } from 'vitest'
import type { MyRequest, TaskWithContext } from '@yoda/shared'
import { answersFor, proposalFallbackKey, requestStatusColor, taskViewFor } from '../app/utils/requests'

describe('requestStatusColor', () => {
  it('maps every status to a colour', () => {
    expect(requestStatusColor('waiting_for_you')).toBe('warning')
    expect(requestStatusColor('in_progress')).toBe('info')
    expect(requestStatusColor('submitted')).toBe('info')
    expect(requestStatusColor('done')).toBe('success')
    expect(requestStatusColor('cancelled')).toBe('default')
  })
})

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
