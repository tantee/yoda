import { GuardReason } from '@yoda/shared'

export type GuardInfo = { reason: GuardReason; detail: string | null }

/**
 * The guard rail that made an `auto-assign` decision wait for the PM: from a proposal's or a timeline event's
 * payload (`guard`, `guardDetail`), else from a plain reason string (task events). Null when there is none.
 */
export function guardOf(payload: Record<string, unknown> | null | undefined, reason?: string | null): GuardInfo | null {
  const fromPayload = GuardReason.safeParse(payload?.guard)
  if (fromPayload.success) {
    const detail = typeof payload?.guardDetail === 'string' && payload.guardDetail.trim() ? payload.guardDetail : null
    return { reason: fromPayload.data, detail }
  }
  const fromReason = GuardReason.safeParse(reason)
  return fromReason.success ? { reason: fromReason.data, detail: null } : null
}
