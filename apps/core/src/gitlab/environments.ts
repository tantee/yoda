import { parseMatchPattern, type MappingRule } from '@yoda/shared'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { deployEnvironments, projectRepos } from '../db/schema.js'
import type { GitLabClient } from './client.js'

type Conn = Db | Tx

/** One environment's state: its URL and tier, and the last successful deployment when known. */
export type Deployment = {
  name: string
  externalUrl: string | null
  tier: string | null
  ref: string | null
  sha: string | null
  status: string | null
  deployedAt: Date | null
}

/**
 * The match pattern for an environment's external URL: its scheme and host (port included), any path.
 * `https://review-12.example.org/app` → `https://review-12.example.org/*`. Null for anything else.
 */
export function externalUrlPattern(url: string | null | undefined): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  const pattern = `${u.protocol}//${u.host.toLowerCase()}/*`
  return parseMatchPattern(pattern) ? pattern : null
}

/**
 * Records a deployment or an environment's state. A deployment older than the stored one is ignored (webhook
 * deliveries can arrive out of order); a state without a deployment (`deployedAt` null) only updates the URL
 * and tier. True when the row changed.
 */
export async function upsertDeployment(db: Conn, repoId: string, d: Deployment): Promise<boolean> {
  const base = { externalUrl: d.externalUrl, tier: d.tier, updatedAt: sql`now()` }
  if (!d.deployedAt) {
    const rows = await db
      .insert(deployEnvironments)
      .values({ repoId, name: d.name, externalUrl: d.externalUrl, tier: d.tier })
      .onConflictDoUpdate({ target: [deployEnvironments.repoId, deployEnvironments.name], set: base })
      .returning({ name: deployEnvironments.name })
    return rows.length > 0
  }
  const rows = await db
    .insert(deployEnvironments)
    .values({ repoId, name: d.name, externalUrl: d.externalUrl, tier: d.tier, ref: d.ref, sha: d.sha, status: d.status, deployedAt: d.deployedAt })
    .onConflictDoUpdate({
      target: [deployEnvironments.repoId, deployEnvironments.name],
      set: { ...base, ref: d.ref, sha: d.sha, status: d.status, deployedAt: d.deployedAt },
      setWhere: sql`${deployEnvironments.deployedAt} is null or ${deployEnvironments.deployedAt} <= ${d.deployedAt.toISOString()}::timestamptz`,
    })
    .returning({ name: deployEnvironments.name })
  return rows.length > 0
}

/** Reads a linked repo's environments and their last deployments from GitLab. Returns how many were stored. */
export async function syncEnvironments(deps: { db: Db; gitlab: GitLabClient | null }, repoId: string): Promise<number> {
  const { db, gitlab } = deps
  if (!gitlab) return 0
  const [repo] = await db.select().from(projectRepos).where(eq(projectRepos.id, repoId))
  if (!repo) return 0
  let n = 0
  for (const env of await gitlab.listEnvironments(repo.gitlabProjectId)) {
    const last = await gitlab.lastDeployment(repo.gitlabProjectId, env.id)
    await upsertDeployment(db, repoId, {
      name: env.name,
      externalUrl: env.external_url ?? null,
      tier: env.tier ?? null,
      ref: last?.ref ?? null,
      sha: last?.sha ?? null,
      status: last?.status ?? null,
      deployedAt: last?.deployedAt ?? null,
    })
    n++
  }
  return n
}

/** Job `gitlab-env-sync`: one repo (`id` = repo id, on link), or every linked repo (the nightly run). */
export async function syncEnvironmentsJob(deps: { db: Db; gitlab: GitLabClient | null }, id: string): Promise<void> {
  if (!deps.gitlab) return
  const ids = id === 'scheduled' ? (await deps.db.select({ id: projectRepos.id }).from(projectRepos).orderBy(asc(projectRepos.id))).map((r) => r.id) : [id]
  const failed: string[] = []
  for (const repoId of ids) {
    try {
      await syncEnvironments(deps, repoId)
    } catch (err) {
      failed.push(repoId)
      console.warn(`gitlab-env-sync: repo ${repoId} failed: ${(err as Error).message}`)
    }
  }
  if (failed.length && id !== 'scheduled') throw new Error(`gitlab-env-sync failed for repo ${id}`)
}

/** The GitLab mapping rules of these projects: environments with an external URL. */
export async function gitlabRules(db: Conn, projectIds: readonly string[]): Promise<MappingRule[]> {
  if (!projectIds.length) return []
  const rows = await db
    .select({ e: deployEnvironments, projectId: projectRepos.projectId, path: projectRepos.pathWithNamespace })
    .from(deployEnvironments)
    .innerJoin(projectRepos, eq(projectRepos.id, deployEnvironments.repoId))
    .where(and(inArray(projectRepos.projectId, [...projectIds]), isNotNull(deployEnvironments.externalUrl)))
    .orderBy(asc(projectRepos.projectId), asc(projectRepos.pathWithNamespace), asc(deployEnvironments.name))
  const rules: MappingRule[] = []
  for (const { e, projectId, path } of rows) {
    const pattern = externalUrlPattern(e.externalUrl)
    if (!pattern) continue
    rules.push({
      pattern,
      projectId,
      environment: e.name,
      production: e.tier === 'production',
      source: 'gitlab',
      build: { repo: path, ref: e.ref, sha: e.sha, deployedAt: e.deployedAt?.toISOString() ?? null },
    })
  }
  return rules
}

/** Production URL patterns of these projects' GitLab environments (tier `production`). */
export async function productionEnvironmentPatterns(db: Conn, projectIds: readonly string[]): Promise<string[]> {
  if (!projectIds.length) return []
  const rows = await db
    .select({ url: deployEnvironments.externalUrl })
    .from(deployEnvironments)
    .innerJoin(projectRepos, eq(projectRepos.id, deployEnvironments.repoId))
    .where(and(inArray(projectRepos.projectId, [...projectIds]), eq(deployEnvironments.tier, 'production'), isNotNull(deployEnvironments.externalUrl)))
  return rows.flatMap((r) => {
    const p = externalUrlPattern(r.url)
    return p ? [p] : []
  })
}
