import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { projectMembers, projects } from '../db/schema.js'
import { productionEnvironmentPatterns } from '../gitlab/environments.js'
import { productionAppUrls } from '../projects/app-urls.js'

/**
 * The ids of every project the person is a member of (admins too: membership only, plan decision 13).
 * `activeOnly` leaves archived projects out (what the extension offers); production rules keep them.
 */
export async function memberProjectIds(db: Db, personId: string, opts: { activeOnly?: boolean } = {}): Promise<string[]> {
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.personId, personId), opts.activeOnly ? eq(projects.status, 'active') : undefined))
  return rows.map((r) => r.id)
}

/**
 * The production URL patterns of every project the person is a member of: application URLs marked production
 * (A7) and GitLab production-tier environments (A8). Core refuses video and buffer files from these pages.
 */
export async function productionRulesForPerson(db: Db, personId: string): Promise<string[]> {
  const ids = await memberProjectIds(db, personId)
  return [...new Set([...(await productionAppUrls(db, ids)), ...(await productionEnvironmentPatterns(db, ids))])]
}
