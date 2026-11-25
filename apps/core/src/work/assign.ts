import type { ProjectRole } from '@yoda/shared'
import { sql } from 'drizzle-orm'
import type { Tx } from '../db/client.js'

/** Start of today in Asia/Bangkok: the daily automatic-assignment cap counts from here. */
export const DAY_START = sql`date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'`

/**
 * Serialises automatic assignment so concurrent creators cannot each see a person just under the daily cap.
 * Held until the transaction ends; always taken after the work item lock.
 */
export async function lockAutoAssign(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('yoda:auto-assign'))`)
}

/**
 * Lowest-load project member holding `role`; ties by display name then id.
 * Load is staff work only: tasks a person holds as a requester (role REQUESTER) do not count.
 */
export async function pickAssignee(
  tx: Tx,
  projectId: string,
  role: ProjectRole,
  /** When set, candidates who already received `cap` automatic assignments today (Asia/Bangkok) are skipped. */
  opts: { cap?: number } = {},
): Promise<string | null> {
  const underCap =
    opts.cap === undefined
      ? sql`true`
      : sql`(
          SELECT count(*) FROM events e
          WHERE e.type = 'task.assigned'
            AND e.payload->>'auto' = 'true'
            AND e.payload->>'assigneeId' = p.id::text
            AND e.created_at >= ${DAY_START}
        ) < ${opts.cap}`
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT p.id
    FROM project_members m
    JOIN people p ON p.id = m.person_id
    WHERE m.project_id = ${projectId} AND ${role} = ANY(m.roles) AND ${underCap}
    ORDER BY (
      SELECT count(*) FROM tasks t
      WHERE t.role <> 'REQUESTER'
        AND ((t.assignee_id = p.id AND t.state IN ('open', 'in_progress'))
          OR (t.proposed_assignee_id = p.id AND t.state = 'proposed'))
    ) ASC, p.display_name ASC, p.id ASC
    LIMIT 1
  `)
  return rows[0]?.id ?? null
}
