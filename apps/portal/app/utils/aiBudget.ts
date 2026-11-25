import type { AiUsage } from '@yoda/shared'

export const MAX_AI_BUDGET_USD = 9_999_999_999.99

/** Share of the budget used, 0-100 (a zero budget with any spend counts as full). */
export function usagePercent(u: AiUsage | null | undefined): number {
  if (!u || u.budgetUsd == null) return 0
  if (u.budgetUsd <= 0) return u.costUsd > 0 ? 100 : 0
  return Math.min(100, (u.costUsd / u.budgetUsd) * 100)
}

export function usageColor(percent: number): 'error' | 'warning' | 'primary' {
  return percent >= 100 ? 'error' : percent >= 80 ? 'warning' : 'primary'
}

/** Empty = no limit (null); otherwise a non-negative amount in whole cents; undefined = invalid. */
export function parseBudgetInput(raw: string): number | null | undefined {
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || n > MAX_AI_BUDGET_USD) return undefined
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return undefined
  return n
}
