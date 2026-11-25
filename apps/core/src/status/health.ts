import type { Health, HealthReason, HealthReasonCode } from '@yoda/shared'

/** Project health thresholds (days, and the share of the month's AI budget). */
export const HEALTH_RULES = { stuckDays: 5, urgentDiscussionDays: 3, highDiscussionDays: 7, budgetRatio: 0.8 } as const

const SAMPLE_SIZE = 3
/** Spend over budget is a quotient of decimals: 2.4 / 3 must count as 80%, not 79.99…%. */
const RATIO_EPSILON = 1e-9

/** Today's calendar date in Asia/Bangkok, `YYYY-MM-DD`. */
export const bangkokDate = (at: Date = new Date()): string => at.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

export type HealthItem = { id: string; title: string }

export type HealthInput = {
  /** Active work items with no event for `stuckDays` or more. */
  stuck: HealthItem[]
  /** Urgent discussions open (or scheduled) for `urgentDiscussionDays` or more. */
  urgentOpen: HealthItem[]
  /** Work items with a failed GitLab issue sync. */
  syncFailed: HealthItem[]
  /** Active work items past their target date. */
  overdue: HealthItem[]
  /** High-priority discussions open (or scheduled) for `highDiscussionDays` or more. */
  highOpen: HealthItem[]
  /** This month's AI spend over the budget; null without a budget. */
  aiRatio: number | null
}

const reason = (code: HealthReasonCode, items: HealthItem[]): HealthReason => ({
  code,
  count: items.length,
  sample: items.slice(0, SAMPLE_SIZE).map(({ id, title }) => ({ id, title })),
})

/** Blocked beats at risk beats on track; every matching reason is kept, blocked ones first. */
export function computeHealth(input: HealthInput): { health: Health; reasons: HealthReason[] } {
  const blocked: HealthReason[] = []
  if (input.stuck.length) blocked.push(reason('stuck', input.stuck))
  if (input.urgentOpen.length) blocked.push(reason('urgent_discussion', input.urgentOpen))
  if (input.syncFailed.length) blocked.push(reason('sync_failed', input.syncFailed))

  const atRisk: HealthReason[] = []
  if (input.overdue.length) atRisk.push(reason('overdue', input.overdue))
  if (input.highOpen.length) atRisk.push(reason('high_discussion', input.highOpen))
  if (input.aiRatio !== null && input.aiRatio + RATIO_EPSILON >= HEALTH_RULES.budgetRatio) {
    // The count is the percent of the budget used.
    atRisk.push({ code: 'ai_budget', count: Math.floor(input.aiRatio * 100 + RATIO_EPSILON * 100), sample: [] })
  }

  const health: Health = blocked.length ? 'blocked' : atRisk.length ? 'at_risk' : 'on_track'
  return { health, reasons: [...blocked, ...atRisk] }
}
