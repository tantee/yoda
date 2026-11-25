import type { Health, HealthReason, HealthReasonCode, WeeklySummaryOutcome } from '@yoda/shared'

/** The slice of vue-i18n's `t` the status helpers need: a key, named values and a plural count. */
export type Translate = (key: string, named: Record<string, unknown>, plural: number) => string

export function healthColor(h: Health): 'success' | 'warning' | 'error' {
  return h === 'blocked' ? 'error' : h === 'at_risk' ? 'warning' : 'success'
}

/** A localized sentence with the reason's count (a percent for `ai_budget`). */
export function reasonText(t: Translate, r: HealthReason): string {
  return t(`status.reason.${r.code}`, { n: r.count }, r.count)
}

/** Where a reason's sample points: the two discussion codes sample discussions, the rest work items. */
export function reasonLink(code: HealthReasonCode, sampleId: string): string {
  return code === 'urgent_discussion' || code === 'high_discussion' ? `/discussions/${sampleId}` : `/work-items/${sampleId}`
}

/** `YYYY-MM-DD` dates compare as strings; the target day itself is not overdue yet. */
export function isOverdue(targetDate: string | null, today: string): boolean {
  return !!targetDate && targetDate < today
}

/** Today's calendar date in Asia/Bangkok, `YYYY-MM-DD`. */
export function bangkokToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
}

/** Share of the budget spent, 0-100; null without a budget (a zero budget with any spend counts as full). */
export function spendPercent(spendUsd: number, budgetUsd: number | null): number | null {
  if (budgetUsd == null) return null
  if (budgetUsd <= 0) return spendUsd > 0 ? 100 : 0
  return Math.min(100, (spendUsd / budgetUsd) * 100)
}

/** US dollars with cents (AI spend is small; under a cent shows as $0.00). */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

/** The message for a weekly summary run's outcome; null when it was written. */
export function outcomeMessageKey(o: WeeklySummaryOutcome): string | null {
  if (o.outcome === 'written') return null
  return o.reason ? `status.weekly.reason.${o.reason}` : 'status.weekly.notWritten'
}

export type Debounced = (() => void) & { cancel: () => void }

/** Runs `fn` once calls pause for `wait` ms, but at least every `maxWait` ms while they keep coming. */
export function debounceMax(fn: () => void, wait: number, maxWait: number): Debounced {
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (waitTimer) clearTimeout(waitTimer)
    if (maxTimer) clearTimeout(maxTimer)
    waitTimer = maxTimer = null
  }
  const flush = () => {
    cancel()
    fn()
  }
  const debounced = () => {
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = setTimeout(flush, wait)
    maxTimer ??= setTimeout(flush, maxWait)
  }
  return Object.assign(debounced, { cancel })
}
