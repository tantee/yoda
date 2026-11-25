import { describe, expect, it } from 'vitest'
import { guardOf } from '../app/utils/guards'

describe('guardOf', () => {
  it('reads the guard from a payload, with its detail', () => {
    expect(guardOf({ fromStep: 'a', toStep: 'b', guard: 'ai_low_confidence', guardDetail: 'ขนาดไฟล์' })).toEqual({
      reason: 'ai_low_confidence',
      detail: 'ขนาดไฟล์',
    })
    expect(guardOf({ guard: 'rework', guardDetail: ' ' })).toEqual({ reason: 'rework', detail: null })
  })

  it('falls back to a reason string; ignores anything that is not a guard', () => {
    expect(guardOf({}, 'daily_cap')).toEqual({ reason: 'daily_cap', detail: null })
    expect(guardOf({ guard: 'nope' }, 'no_candidate')).toBeNull()
    expect(guardOf(null)).toBeNull()
  })
})
