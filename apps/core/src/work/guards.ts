import type { GuardReason, TaskResult, TemplateStep } from '@yoda/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { monthUsage } from '../ai/gateway.js'
import type { Tx } from '../db/client.js'
import { projectMembers, tasks } from '../db/schema.js'
import type { WorkItemRow } from './engine.js'

/**
 * Guard rails of `auto-assign` projects: checks at the two automatic decisions (advancing a step, assigning a
 * task). A tripped guard hands the decision back to the PM as a proposal, with the reason recorded.
 * Every check is a read under the work item lock its caller holds.
 */

export type GuardTrip = { reason: GuardReason; detail?: string }

/** Share of the project's monthly AI budget from which a step with AI tasks waits for the PM. */
export const AI_BUDGET_GUARD_SHARE = 0.8
/** Change requests on one task from which its next attempt and the step advance go to the PM. */
export const REPEATED_REWORK = 2

/** Plain-language reason (Thai: notifications and stored proposal text are Thai, like the rest of core). */
const GUARD_TEXT_TH: Record<GuardReason, string> = {
  rework: 'มีการขอให้แก้ไขงานในขั้นตอนนี้',
  repeated_rework: 'งานถูกส่งกลับให้แก้ไขตั้งแต่ 2 ครั้งขึ้นไป',
  ai_low_confidence: 'AI ไม่มั่นใจในร่างงานหรือขาดข้อมูล',
  high_priority: 'งานมีความสำคัญสูงหรือเร่งด่วน',
  ai_budget: 'งบ AI ของโครงการเดือนนี้ใช้ไปแล้วตั้งแต่ 80%',
  daily_cap: 'ทุกคนที่รับงานนี้ได้ครบจำนวนงานต่อวันแล้ว',
  no_assignee: 'ขั้นตอนถัดไปมีงานที่ไม่มีสมาชิกในบทบาทที่ต้องใช้',
  requester_changes: 'ผู้ขอขอให้แก้ไขงานที่ส่งมอบ',
}

const DETAIL_LABEL_TH: Partial<Record<GuardReason, string>> = {
  ai_low_confidence: 'ข้อมูลที่ขาด',
  no_assignee: 'บทบาท',
}

export function guardText(trip: GuardTrip): string {
  const base = GUARD_TEXT_TH[trip.reason]
  if (!trip.detail) return base
  const label = DETAIL_LABEL_TH[trip.reason]
  return `${base} (${label ? `${label}: ` : ''}${trip.detail})`
}

/** A rejected attempt that asked for changes (not one rejected by a cancel or a reopen). */
const changesRequested = and(eq(tasks.state, 'rejected'), sql`${tasks.result}->>'decision' = 'changes'`)

/**
 * Times the task `key` was sent back in its current (not superseded) round: its own change requests, plus
 * those of the step's tasks that depend on it (a review asking for changes sends its subject back).
 */
export async function reworkCount(tx: Tx, workItemId: string, step: TemplateStep, key: string): Promise<number> {
  const keys = [key, ...step.tasks.filter((t) => t.dependsOn.includes(key)).map((t) => t.key)]
  const rows = await tx
    .select({ key: tasks.templateTaskKey, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), isNull(tasks.supersededAt), inArray(tasks.templateTaskKey, keys), changesRequested))
    .groupBy(tasks.templateTaskKey)
  return rows.reduce((sum, r) => sum + r.n, 0)
}

/**
 * Evaluated when `step` of an `auto-assign` work item is complete and `next` follows. First match wins, in the
 * order G8, G2, G1, G3, G4, G5, G7; null lets the item advance automatically.
 */
export async function checkAdvanceGuards(
  tx: Tx,
  item: WorkItemRow,
  step: TemplateStep,
  next: TemplateStep,
): Promise<GuardTrip | null> {
  // G8: the requester asked for changes since the item was last reopened.
  const requesterChanges = await tx.execute<{ id: string }>(sql`
    SELECT t.id FROM tasks t
    JOIN events e ON e.task_id = t.id AND e.type = 'task.rejected'
    WHERE t.work_item_id = ${item.id}
      AND t.role = 'REQUESTER'
      AND t.state = 'rejected'
      AND t.result->>'decision' = 'changes'
      AND e.seq > coalesce(
        (SELECT max(r.seq) FROM events r WHERE r.work_item_id = ${item.id} AND r.type = 'work_item.reopened'),
        0
      )
    LIMIT 1
  `)
  if (requesterChanges.length) return { reason: 'requester_changes' }

  // G2 / G1: change requests in this step's current round.
  const rejected = await tx
    .select({ key: tasks.templateTaskKey, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.workItemId, item.id), eq(tasks.stepKey, step.key), isNull(tasks.supersededAt), changesRequested))
    .groupBy(tasks.templateTaskKey)
  if (rejected.some((r) => r.n >= REPEATED_REWORK)) return { reason: 'repeated_rework' }
  if (rejected.length) return { reason: 'rework' }

  // G3: an accepted AI draft of this step said it was unsure or lacked information.
  const drafts = await tx
    .select({ result: tasks.result })
    .from(tasks)
    .where(
      and(
        eq(tasks.workItemId, item.id),
        eq(tasks.stepKey, step.key),
        isNull(tasks.supersededAt),
        eq(tasks.state, 'accepted'),
        eq(tasks.executor, 'ai'),
      ),
    )
  const unsure = drafts.map((d) => d.result as TaskResult | null).filter((r) => r?.confidence === 'low' || !!r?.missing?.length)
  if (unsure.length) {
    const missing = [...new Set(unsure.flatMap((r) => r?.missing ?? []))]
    return missing.length ? { reason: 'ai_low_confidence', detail: missing.join(', ') } : { reason: 'ai_low_confidence' }
  }

  // G4
  if (item.priority === 'high' || item.priority === 'urgent') return { reason: 'high_priority' }

  // G5: spending this month is near the budget and the next step would spend more.
  if (next.tasks.some((t) => t.type === 'ai')) {
    const usage = await monthUsage(tx, item.projectId)
    if (usage.budgetUsd !== null && usage.costUsd >= usage.budgetUsd * AI_BUDGET_GUARD_SHARE) return { reason: 'ai_budget' }
  }

  // G7: a person's task in the next step whose role nobody in the project holds.
  const needed = [...new Set(next.tasks.filter((t) => t.type !== 'ai' && t.role !== 'REQUESTER').map((t) => t.role))]
  if (needed.length) {
    const members = await tx.select({ roles: projectMembers.roles }).from(projectMembers).where(eq(projectMembers.projectId, item.projectId))
    const held = new Set(members.flatMap((m) => m.roles))
    const missing = needed.filter((r) => !held.has(r))
    if (missing.length) return { reason: 'no_assignee', detail: missing.join(', ') }
  }
  return null
}
