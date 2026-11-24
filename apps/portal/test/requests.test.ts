import { describe, expect, it } from 'vitest'
import type { MyRequest, TaskWithContext } from '@yoda/shared'
import { answersFor, proposalFallbackKey, requestStatusColor } from '../app/utils/requests'

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
