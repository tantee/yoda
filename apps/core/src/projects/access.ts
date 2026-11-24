import { and, eq } from 'drizzle-orm'
import type { Me } from '@yoda/shared'
import type { Db } from '../db/client.js'
import { projectMembers } from '../db/schema.js'

/** Admins, or members holding the `PM` role on the project. */
export async function canManageProject(db: Db, me: Me, projectId: string): Promise<boolean> {
  if (me.isAdmin) return true
  const [row] = await db
    .select({ roles: projectMembers.roles })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, me.id)))
  return row?.roles.includes('PM') ?? false
}
