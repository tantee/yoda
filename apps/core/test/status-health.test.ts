import { describe, expect, it } from 'vitest'
import { bangkokDate, computeHealth, HEALTH_RULES, type HealthInput } from '../src/status/health.js'

const item = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, title: `งาน ${n}` })
const empty: HealthInput = { stuck: [], urgentOpen: [], syncFailed: [], overdue: [], highOpen: [], aiRatio: null }

describe('computeHealth', () => {
  it('is on track with no reasons for an empty input', () => {
    expect(computeHealth(empty)).toEqual({ health: 'on_track', reasons: [] })
  })

  it.each([
    ['stuck', 'blocked', 'stuck'],
    ['urgentOpen', 'blocked', 'urgent_discussion'],
    ['syncFailed', 'blocked', 'sync_failed'],
    ['overdue', 'at_risk', 'overdue'],
    ['highOpen', 'at_risk', 'high_discussion'],
  ] as const)('%s alone → %s (%s)', (field, health, code) => {
    const r = computeHealth({ ...empty, [field]: [item(1), item(2)] })
    expect(r.health).toBe(health)
    expect(r.reasons).toEqual([{ code, count: 2, sample: [item(1), item(2)] }])
  })

  it('flags the AI budget at the ratio, with the percent used as the count', () => {
    expect(computeHealth({ ...empty, aiRatio: HEALTH_RULES.budgetRatio - 0.01 })).toEqual({ health: 'on_track', reasons: [] })
    expect(computeHealth({ ...empty, aiRatio: 0.85 })).toEqual({
      health: 'at_risk',
      reasons: [{ code: 'ai_budget', count: 85, sample: [] }],
    })
  })

  it('puts blocked before at risk, and blocked wins', () => {
    const r = computeHealth({ ...empty, overdue: [item(1)], aiRatio: 1.2, syncFailed: [item(2)], stuck: [item(3)] })
    expect(r.health).toBe('blocked')
    expect(r.reasons.map((x) => x.code)).toEqual(['stuck', 'sync_failed', 'overdue', 'ai_budget'])
  })

  it('keeps up to three samples but counts all', () => {
    const r = computeHealth({ ...empty, overdue: [1, 2, 3, 4, 5].map(item) })
    expect(r.reasons[0]).toMatchObject({ count: 5, sample: [item(1), item(2), item(3)] })
  })

  it('uses the documented thresholds', () => {
    expect(HEALTH_RULES).toEqual({ stuckDays: 5, urgentDiscussionDays: 3, highDiscussionDays: 7, budgetRatio: 0.8 })
  })

  it('reads the date in Asia/Bangkok', () => {
    // 2026-11-24 18:30 UTC is already 2026-11-25 01:30 in Bangkok.
    expect(bangkokDate(new Date('2026-11-24T18:30:00Z'))).toBe('2026-11-25')
  })
})
