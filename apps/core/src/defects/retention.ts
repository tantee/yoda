import { LOG_ROLES, MEDIA_ROLES, SETTINGS } from '@yoda/shared'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { attachments, workItems } from '../db/schema.js'
import { recordEvent, runWork } from '../work/context.js'

export type RetentionDeps = Pick<AppDeps, 'db' | 'storage' | 'settings' | 'bus' | 'jobs' | 'config'>

const DAY_MS = 86_400_000
/** Objects younger than this may belong to an upload still committing; the sweep leaves them. */
export const ORPHAN_AGE_MS = DAY_MS
/** Where defect files live: `projects/<projectId>/defects/…` (plan A6). */
const DEFECT_KEY = /^projects\/[^/]+\/defects\//

const days = (deps: RetentionDeps, key: 'extension.mediaRetentionDays' | 'extension.logRetentionDays'): number =>
  Number(deps.settings?.get(key) ?? SETTINGS[key].default)

/**
 * Removes defect files whose work item closed (its latest `work_item.done` or `work_item.cancelled` event) longer
 * ago than the retention period: media after `extension.mediaRetentionDays`, logs after
 * `extension.logRetentionDays`; 0 keeps them. Active items, reopened ones included, are skipped. Each purge
 * removes the object, sets `purged_at` (the row stays) and records `attachment.purged` (actor system).
 */
export async function purgeExpired(deps: RetentionDeps, now: Date): Promise<{ media: number; logs: number }> {
  const out = { media: 0, logs: 0 }
  const groups = [
    { roles: MEDIA_ROLES as readonly string[], days: days(deps, 'extension.mediaRetentionDays'), count: 'media' as const },
    { roles: LOG_ROLES as readonly string[], days: days(deps, 'extension.logRetentionDays'), count: 'logs' as const },
  ]
  for (const g of groups) {
    if (g.days <= 0) continue
    const cutoff = new Date(now.getTime() - g.days * DAY_MS)
    const closedAt = sql`(select max(e.created_at) from events e where e.work_item_id = ${workItems.id} and e.type in ('work_item.done', 'work_item.cancelled'))`
    const due = await deps.db
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(workItems, eq(workItems.id, attachments.workItemId))
      .where(
        and(
          inArray(attachments.role, [...g.roles]),
          isNull(attachments.purgedAt),
          inArray(workItems.state, ['done', 'cancelled']),
          sql`${closedAt} <= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
    for (const { id } of due) if (await purgeOne(deps, id, { kind: 'retention' })) out[g.count]++
  }
  return out
}

/**
 * Removes one defect file's object and marks the row purged, in one transaction with its event: the row is
 * locked and re-checked, so a concurrent removal or a reopened item is never purged twice or by mistake.
 * `by`: a person (`attachment.removed`, with the reason) or retention (`attachment.purged`, actor system).
 */
export async function purgeOne(
  deps: RetentionDeps,
  attachmentId: string,
  by: { kind: 'retention' } | { kind: 'person'; personId: string; reason: string },
): Promise<boolean> {
  const actor = by.kind === 'person' ? { id: by.personId, kind: 'person' as const } : { id: null, kind: 'system' as const }
  return runWork(deps, actor, async (ctx) => {
    const [row] = await ctx.tx.select().from(attachments).where(eq(attachments.id, attachmentId)).for('update')
    if (!row || !row.role || row.purgedAt || !row.projectId) return false
    if (by.kind === 'retention' && row.workItemId) {
      const [w] = await ctx.tx.select({ state: workItems.state }).from(workItems).where(eq(workItems.id, row.workItemId))
      if (!w || w.state === 'active') return false
    }
    await deps.storage.remove(row.storageKey)
    await ctx.tx.update(attachments).set({ purgedAt: sql`now()` }).where(eq(attachments.id, attachmentId))
    await recordEvent(ctx, {
      type: by.kind === 'person' ? 'attachment.removed' : 'attachment.purged',
      projectId: row.projectId,
      workItemId: row.workItemId,
      taskId: null,
      payload: by.kind === 'person' ? { attachmentId, role: row.role, reason: by.reason } : { attachmentId, role: row.role },
    })
    return true
  })
}

/**
 * Removes objects under `projects/<id>/defects/` that no attachment row names and that are older than a day:
 * left behind by a crash between a defect upload's puts and its rollback. Returns how many were removed.
 */
export async function sweepOrphans(deps: Pick<AppDeps, 'db' | 'storage'>, now: Date): Promise<number> {
  const before = now.getTime() - ORPHAN_AGE_MS
  const candidates: string[] = []
  for await (const o of deps.storage.list('projects/')) {
    if (DEFECT_KEY.test(o.key) && o.lastModified.getTime() < before) candidates.push(o.key)
  }
  let removed = 0
  for (let i = 0; i < candidates.length; i += 500) {
    const batch = candidates.slice(i, i + 500)
    const known = await deps.db
      .select({ key: attachments.storageKey })
      .from(attachments)
      .where(and(inArray(attachments.storageKey, batch), isNotNull(attachments.storageKey)))
    const named = new Set(known.map((k) => k.key))
    for (const key of batch) {
      if (named.has(key)) continue
      await deps.storage.remove(key)
      removed++
    }
  }
  return removed
}
