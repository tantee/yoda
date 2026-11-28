import { LOG_ROLES, MEDIA_ROLES, SETTINGS } from '@yoda/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { attachments, projects, workItems } from '../db/schema.js'
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
  let failed = 0
  const groups = [
    { roles: MEDIA_ROLES as readonly string[], days: days(deps, 'extension.mediaRetentionDays'), count: 'media' as const },
    { roles: LOG_ROLES as readonly string[], days: days(deps, 'extension.logRetentionDays'), count: 'logs' as const },
  ]
  for (const g of groups) {
    if (g.days <= 0) continue
    const cutoff = new Date(now.getTime() - g.days * DAY_MS)
    const closedAt = sql`(select max(e.created_at) from events e where e.work_item_id = ${workItems.id} and e.type in ('work_item.done', 'work_item.cancelled'))`
    const due = await deps.db
      .select({ id: attachments.id, workItemId: attachments.workItemId })
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
      .orderBy(attachments.id)
    // One bad object never stops the rest: each failure is logged, and the run fails at the end.
    for (const { id } of due) {
      try {
        if (await purgeOne(deps, id, { kind: 'retention', cutoff })) out[g.count]++
      } catch (err) {
        failed++
        console.warn(`defect-retention: attachment ${id} failed: ${(err as Error).message}`)
      }
    }
  }
  if (failed) throw new Error(`defect-retention: ${failed} file(s) could not be purged (purged ${out.media} media, ${out.logs} logs)`)
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
  by: { kind: 'retention'; cutoff: Date } | { kind: 'person'; personId: string; reason: string },
): Promise<boolean> {
  const actor = by.kind === 'person' ? { id: by.personId, kind: 'person' as const } : { id: null, kind: 'system' as const }
  return runWork(deps, actor, async (ctx) => {
    const [row] = await ctx.tx.select().from(attachments).where(eq(attachments.id, attachmentId)).for('update')
    if (!row || !row.role || row.purgedAt || !row.projectId) return false
    if (by.kind === 'retention') {
      // Re-checked under locks: the item may have been reopened (and closed again) since it was found due.
      if (!row.workItemId) return false
      const [w] = await ctx.tx
        .select({
          state: workItems.state,
          due: sql<boolean>`coalesce((select max(e.created_at) from events e where e.work_item_id = ${row.workItemId}::uuid and e.type in ('work_item.done', 'work_item.cancelled')) <= ${by.cutoff.toISOString()}::timestamptz, false)`,
        })
        .from(workItems)
        .where(eq(workItems.id, row.workItemId))
        .for('share')
      if (!w || w.state === 'active' || !w.due) return false
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
 * left behind by a crash between a defect upload's puts and its commit. Lists each existing project's defect
 * folder only, never ordinary uploads. Returns how many were removed; one failing key never stops it.
 */
export async function sweepOrphans(deps: Pick<AppDeps, 'db' | 'storage'>, now: Date): Promise<number> {
  const before = now.getTime() - ORPHAN_AGE_MS
  const projectIds = (await deps.db.select({ id: projects.id }).from(projects)).map((p) => p.id)
  let removed = 0
  let failed = 0
  for (const id of projectIds) {
    const candidates: string[] = []
    for await (const o of deps.storage.list(`projects/${id}/defects/`)) {
      if (DEFECT_KEY.test(o.key) && o.lastModified.getTime() < before) candidates.push(o.key)
    }
    for (let i = 0; i < candidates.length; i += 500) {
      const batch = candidates.slice(i, i + 500)
      const known = await deps.db.select({ key: attachments.storageKey }).from(attachments).where(inArray(attachments.storageKey, batch))
      const named = new Set(known.map((k) => k.key))
      for (const key of batch) {
        if (named.has(key)) continue
        try {
          await deps.storage.remove(key)
          removed++
        } catch (err) {
          failed++
          console.warn(`defect-orphan-sweep: ${key} failed: ${(err as Error).message}`)
        }
      }
    }
  }
  if (failed) throw new Error(`defect-orphan-sweep: ${failed} object(s) could not be removed (${removed} removed)`)
  return removed
}
