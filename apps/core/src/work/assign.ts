import type { ProjectRole } from '@yoda/shared'
import { sql } from 'drizzle-orm'
import type { Tx } from '../db/client.js'

/** Lowest-load project member holding `role`; ties by display name then id. */
export async function pickAssignee(tx: Tx, projectId: string, role: ProjectRole): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT p.id
    FROM project_members m
    JOIN people p ON p.id = m.person_id
    WHERE m.project_id = ${projectId} AND ${role} = ANY(m.roles)
    ORDER BY (
      SELECT count(*) FROM tasks t
      WHERE (t.assignee_id = p.id AND t.state IN ('open', 'in_progress'))
         OR (t.proposed_assignee_id = p.id AND t.state = 'proposed')
    ) ASC, p.display_name ASC, p.id ASC
    LIMIT 1
  `)
  return rows[0]?.id ?? null
}
