import { parseMatchPattern, type MappingRule } from '@yoda/shared'
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { deployEnvironments, projectRepos } from '../db/schema.js'
import { GitLabError, type GitLabClient } from './client.js'

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
 * Records a deployment or an environment's state. The deployment fields (ref, sha, status, time) never go back
 * in time: a deployment older than the stored one is ignored (webhook deliveries arrive out of order), and an
 * absent ref keeps the stored one. The URL and tier follow the deployment from a webhook, and always take the
 * current value from a sync (the Environments API is the current state). True when the row changed.
 */
export async function upsertDeployment(db: Conn, repoId: string, d: Deployment, source: 'webhook' | 'sync' = 'webhook'): Promise<boolean> {
  const newer = d.deployedAt
    ? sql`(${deployEnvironments.deployedAt} is null or ${deployEnvironments.deployedAt} <= ${d.deployedAt.toISOString()}::timestamptz)`
    : sql`false`
  const keep = <T>(col: T, value: unknown) => sql`case when ${newer} then ${value} else ${col} end`
  const url = source === 'sync' ? { externalUrl: d.externalUrl, tier: d.tier } : { externalUrl: keep(deployEnvironments.externalUrl, d.externalUrl), tier: keep(deployEnvironments.tier, d.tier) }
  const rows = await db
    .insert(deployEnvironments)
    .values({ repoId, name: d.name, externalUrl: d.externalUrl, tier: d.tier, ref: d.ref, sha: d.sha, status: d.status, deployedAt: d.deployedAt })
    .onConflictDoUpdate({
      target: [deployEnvironments.repoId, deployEnvironments.name],
      set: {
        ...url,
        ref: keep(deployEnvironments.ref, sql`coalesce(${d.ref}, ${deployEnvironments.ref})`),
        sha: keep(deployEnvironments.sha, d.sha),
        status: keep(deployEnvironments.status, d.status),
        deployedAt: keep(deployEnvironments.deployedAt, d.deployedAt?.toISOString() ?? null),
        updatedAt: sql`now()`,
      },
    })
    .returning({ name: deployEnvironments.name })
  return rows.length > 0
}

/**
 * Reads a linked repo's environments and their last deployments from GitLab; environments no longer listed
 * (stopped or deleted) are removed, but only after a complete listing. Returns how many are stored.
 */
export async function syncEnvironments(deps: { db: Db; gitlab: GitLabClient | null }, repoId: string, signal?: AbortSignal): Promise<number> {
  const { db, gitlab } = deps
  if (!gitlab) return 0
  const [repo] = await db.select().from(projectRepos).where(eq(projectRepos.id, repoId))
  if (!repo) return 0
  const envs = await gitlab.listEnvironments(repo.gitlabProjectId)
  for (const env of envs ?? []) {
    if (signal?.aborted) throw new Error('aborted')
    const last = await gitlab.lastDeployment(repo.gitlabProjectId, env.id)
    await upsertDeployment(
      db,
      repoId,
      {
        name: env.name,
        externalUrl: env.external_url ?? null,
        tier: env.tier ?? null,
        ref: last?.ref ?? null,
        sha: last?.sha ?? null,
        status: last?.status ?? null,
        deployedAt: last?.deployedAt ?? null,
      },
      'sync',
    )
  }
  if (envs === null) {
    console.warn(`gitlab-env-sync: repo ${repoId} has more environments than one sync reads; none were pruned`)
    return (await db.select({ n: sql<number>`count(*)::int` }).from(deployEnvironments).where(eq(deployEnvironments.repoId, repoId)))[0]!.n
  }
  const names = envs.map((e) => e.name)
  await db
    .delete(deployEnvironments)
    .where(and(eq(deployEnvironments.repoId, repoId), names.length ? notInArray(deployEnvironments.name, names) : undefined))
  return envs.length
}

/**
 * Job `gitlab-env-sync`: one repo (`id` = repo id, on link), or every linked repo (the nightly run). The sweep
 * stops at the first unreachable-GitLab error and when the job is aborted; it fails when no repo synced.
 */
export async function syncEnvironmentsJob(deps: { db: Db; gitlab: GitLabClient | null }, id: string, signal?: AbortSignal): Promise<void> {
  if (!deps.gitlab) return
  const ids = id === 'scheduled' ? (await deps.db.select({ id: projectRepos.id }).from(projectRepos).orderBy(asc(projectRepos.id))).map((r) => r.id) : [id]
  let failed = 0
  let done = 0
  for (const repoId of ids) {
    if (signal?.aborted) break
    try {
      await syncEnvironments(deps, repoId, signal)
      done++
    } catch (err) {
      failed++
      if (err instanceof GitLabError && err.code === 'unavailable') break
    }
  }
  if (failed) console.warn(`gitlab-env-sync: ${failed} of ${ids.length} repo(s) failed, ${done} synced`)
  if (failed && done === 0) throw new Error(`gitlab-env-sync failed for ${failed} repo(s)`)
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
