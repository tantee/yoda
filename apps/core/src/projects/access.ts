import { and, eq, sql } from 'drizzle-orm'
import type { Me } from '@yoda/shared'
import { notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { projectMembers } from '../db/schema.js'

/** Admins, or members holding the `PM` role on the project. */
export async function canManageProject(db: Db | Tx, me: Me, projectId: string): Promise<boolean> {
  if (me.isAdmin) return true
  const [row] = await db
    .select({ roles: projectMembers.roles })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, me.id)))
  return row?.roles.includes('PM') ?? false
}

/**
 * Lock the project row; 404 when it does not exist.
 * - `exclusive` (membership changes, member removal): serializes with other exclusive lockers and with `share`.
 * - `share` (work item creation): blocks while membership is changing, so a new item never picks a member
 *   whose removal is in flight.
 * `FOR NO KEY UPDATE` rather than `FOR UPDATE`: inserts of tasks/events take `FOR KEY SHARE` on the project
 * through their foreign keys while holding a work item lock; `FOR UPDATE` would conflict with that and
 * deadlock against member removal, which locks the project first and then the work items.
 */
export async function lockProject(tx: Tx, id: string, mode: 'exclusive' | 'share' = 'exclusive'): Promise<void> {
  const rows =
    mode === 'exclusive'
      ? await tx.execute(sql`select 1 from projects where id = ${id} for no key update`)
      : await tx.execute(sql`select 1 from projects where id = ${id} for share`)
  if (rows.length === 0) throw notFound()
}
