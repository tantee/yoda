import type { Me, Runner } from '@yoda/shared'
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { agentRuns, people, runners, tasks } from '../db/schema.js'
import { lockProject } from '../projects/access.js'
import { lockItem } from '../work/engine.js'
import { recordEvent, runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import type { PersonRow } from '../auth/people.js'
import { hashToken, RUNNER_TOKEN_RE } from './tokens.js'

export type RunnerRow = typeof runners.$inferSelect

const LAST_SEEN_THROTTLE_MS = 60_000

/**
 * A person's `Me` from their stored row, for requests that carry no Keycloak token (runners). Matches the auth
 * hook: admins count as staff, and `staff_override` wins over the staff group last seen in a token.
 */
export function meFromPerson(p: PersonRow): Me {
  return {
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    email: p.email,
    isAdmin: p.isAdmin,
    isStaff: p.isAdmin || (p.staffOverride ?? p.lastSeenStaff),
  }
}

/**
 * Authenticates an MCP request by its runner token. Null for anything but a live `Bearer yoda_rt_…` token whose
 * runner is not revoked and whose owner still exists and is staff.
 */
export async function authenticateRunner(
  db: Db,
  authorization: string | undefined,
): Promise<{ runner: RunnerRow; owner: Me } | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token || !RUNNER_TOKEN_RE.test(token)) return null
  // The lookup is by hash through a unique index, so timing reveals nothing about the stored token.
  const [found] = await db
    .select({ runner: runners, owner: people })
    .from(runners)
    .innerJoin(people, eq(people.id, runners.ownerId))
    .where(eq(runners.tokenHash, hashToken(token)))
  if (!found || found.runner.revokedAt) return null
  const owner = meFromPerson(found.owner)
  if (!owner.isStaff) return null
  let runner = found.runner
  if (!runner.lastSeenAt || Date.now() - runner.lastSeenAt.getTime() >= LAST_SEEN_THROTTLE_MS) {
    const [updated] = await db.update(runners).set({ lastSeenAt: sql`now()` }).where(eq(runners.id, runner.id)).returning()
    if (updated) runner = updated
  }
  return { runner, owner }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** Runners as the API shows them; never includes the token hash. */
export async function listRunners(db: Db | Tx, where?: SQL): Promise<Runner[]> {
  const rows = await db
    .select({
      runner: runners,
      ownerName: people.displayName,
      activeRuns: sql<number>`(select count(*)::int from ${agentRuns} where ${agentRuns.runnerId} = ${runners.id} and ${agentRuns.state} = 'running')`,
    })
    .from(runners)
    .innerJoin(people, eq(people.id, runners.ownerId))
    .where(where)
    .orderBy(asc(runners.createdAt), asc(runners.id))
  return rows.map(({ runner: r, ownerName, activeRuns }) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as Runner['kind'],
    ownerId: r.ownerId,
    ownerName,
    accountType: r.accountType as Runner['accountType'],
    capabilities: r.capabilities as Runner['capabilities'],
    mode: r.mode as Runner['mode'],
    maxConcurrent: r.maxConcurrent,
    workingHours: r.workingHours ?? null,
    paused: r.paused,
    revokedAt: iso(r.revokedAt),
    lastSeenAt: iso(r.lastSeenAt),
    activeRuns: Number(activeRuns),
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function getRunner(db: Db | Tx, id: string): Promise<Runner | null> {
  return (await listRunners(db, eq(runners.id, id)))[0] ?? null
}

/**
 * A run's task after the run ended without a result: an unassigned AI task goes back to the queue; a task
 * assigned to a person stays with them. The task must already be locked.
 */
export async function reopenTaskAfterRun(tx: Tx, task: typeof tasks.$inferSelect): Promise<void> {
  if (task.executor !== 'ai' || task.assigneeId !== null || task.state !== 'in_progress') return
  await tx.update(tasks).set({ state: 'open', updatedAt: sql`now()` }).where(eq(tasks.id, task.id))
}

/**
 * Revokes a runner in two transactions. The first sets `revoked_at`: a claim in flight holds the runner row
 * FOR NO KEY UPDATE, so this waits for it to commit, and any later claim sees the revoke and is refused. The second
 * then releases every running run (including one claimed just before), locking in the global order:
 * projects, then work items, then tasks, each sorted.
 */
export async function revokeRunner(deps: WorkDeps, me: Me, runnerId: string): Promise<void> {
  await deps.db
    .update(runners)
    .set({ revokedAt: sql`coalesce(${runners.revokedAt}, now())` })
    .where(eq(runners.id, runnerId))
  await runWork(deps, { id: me.id, kind: 'person' }, async (ctx) => {
    const { tx } = ctx
    const running = await tx
      .select({ runId: agentRuns.id, taskId: tasks.id, projectId: tasks.projectId, workItemId: tasks.workItemId })
      .from(agentRuns)
      .innerJoin(tasks, eq(tasks.id, agentRuns.taskId))
      .where(and(eq(agentRuns.runnerId, runnerId), eq(agentRuns.state, 'running')))
    const sorted = (xs: string[]) => [...new Set(xs)].sort()
    for (const id of sorted(running.map((r) => r.projectId))) await lockProject(tx, id, 'share')
    for (const id of sorted(running.map((r) => r.workItemId))) await lockItem(tx, id)
    if (running.length > 0) {
      await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, sorted(running.map((r) => r.taskId)))).orderBy(asc(tasks.id)).for('update')
    }
    for (const r of running) {
      await endRun(ctx, r.runId, { state: 'released', event: 'run.released', reason: 'runner_revoked' })
    }
  })
}

/**
 * Ends a running run and records its event; unless `reopen` is false, the task goes back to the queue when it
 * is an unassigned AI task (see `reopenTaskAfterRun`). The run's task must already be locked. `where` narrows
 * the update (e.g. "the lease has passed"). Returns the ended run, or null when it was not running (anymore).
 */
export async function endRun(
  ctx: WorkCtx,
  runId: string,
  opts: {
    state: 'released' | 'failed' | 'expired' | 'succeeded' | 'parked'
    event: 'run.released' | 'run.failed' | 'run.expired' | 'run.succeeded' | 'run.parked'
    reason: string | null
    error?: string | null
    where?: SQL
    payload?: Record<string, unknown>
    /** Also set on the run (e.g. the usage reported with a result). */
    set?: Partial<Pick<typeof agentRuns.$inferInsert, 'usage'>>
    reopen?: boolean
  },
): Promise<typeof agentRuns.$inferSelect | null> {
  const [run] = await ctx.tx
    .update(agentRuns)
    .set({ ...opts.set, state: opts.state, endedAt: sql`now()`, error: opts.error ?? null })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.state, 'running'), opts.where))
    .returning()
  if (!run) return null
  const [task] = await ctx.tx.select().from(tasks).where(eq(tasks.id, run.taskId))
  if (!task) return run
  if (opts.reopen !== false) await reopenTaskAfterRun(ctx.tx, task)
  await recordEvent(ctx, {
    type: opts.event,
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskId: task.id,
    reason: opts.reason,
    payload: { runId: run.id, runnerId: run.runnerId, ...opts.payload },
  })
  return run
}
