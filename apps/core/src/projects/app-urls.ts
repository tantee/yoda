import { AppUrl, type AppUrlsPut, type MappingRule } from '@yoda/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { projectAppUrls } from '../db/schema.js'

type Conn = Db | Tx
type Row = typeof projectAppUrls.$inferSelect
/** Byte order, the same under every database collation. */
const byPattern = sql`${projectAppUrls.pattern} collate "C"`

const toAppUrl = (r: Row): AppUrl =>
  AppUrl.parse({ id: r.id, pattern: r.pattern, environment: r.environment, production: r.production, createdAt: r.createdAt.toISOString() })

/** A project's application URLs, by pattern. */
export async function listAppUrls(db: Conn, projectId: string): Promise<AppUrl[]> {
  const rows = await db.select().from(projectAppUrls).where(eq(projectAppUrls.projectId, projectId)).orderBy(byPattern)
  return rows.map(toAppUrl)
}

/** Replaces the whole list (the caller checked the PM / admin right and holds the project lock). */
export async function replaceAppUrls(tx: Tx, projectId: string, input: AppUrlsPut, by: string): Promise<AppUrl[]> {
  await tx.delete(projectAppUrls).where(eq(projectAppUrls.projectId, projectId))
  if (input.urls.length) {
    await tx.insert(projectAppUrls).values(input.urls.map((u) => ({ projectId, pattern: u.pattern, environment: u.environment, production: u.production, createdBy: by })))
  }
  return listAppUrls(tx, projectId)
}

/** The `app_url` mapping rules of these projects (the extension matches them locally: plan decision 3). */
export async function appUrlRules(db: Conn, projectIds: readonly string[]): Promise<MappingRule[]> {
  if (!projectIds.length) return []
  const rows = await db
    .select()
    .from(projectAppUrls)
    .where(inArray(projectAppUrls.projectId, [...projectIds]))
    .orderBy(asc(projectAppUrls.projectId), byPattern)
  return rows.map((r) => ({ pattern: r.pattern, projectId: r.projectId, environment: r.environment, production: r.production, source: 'app_url', build: null }))
}

/** Production application URL patterns of these projects. */
export async function productionAppUrls(db: Conn, projectIds: readonly string[]): Promise<string[]> {
  if (!projectIds.length) return []
  const rows = await db
    .select({ pattern: projectAppUrls.pattern })
    .from(projectAppUrls)
    .where(and(inArray(projectAppUrls.projectId, [...projectIds]), eq(projectAppUrls.production, true)))
  return rows.map((r) => r.pattern)
}
