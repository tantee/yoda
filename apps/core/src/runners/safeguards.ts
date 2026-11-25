import type { ClaimRefusal, WorkingHours } from '@yoda/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '../db/client.js'
import { agentRuns, projects, runnerSettings } from '../db/schema.js'
import { monthUsage } from '../ai/gateway.js'
import type { RunnerCtx } from './claims.js'

const BANGKOK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Bangkok',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Is `at` inside the working hours (days 0 = Sunday … 6, `start` ≤ time < `end`), in Asia/Bangkok? */
export function withinWorkingHours(hours: WorkingHours, at: Date): boolean {
  const parts = Object.fromEntries(BANGKOK.formatToParts(at).map((p) => [p.type, p.value]))
  const day = WEEKDAYS.indexOf(parts.weekday ?? '')
  const time = `${parts.hour}:${parts.minute}`
  return hours.days.includes(day) && time >= hours.start && time < hours.end
}

/**
 * The first reason this runner may not claim work in the project now, or null. `rc.runner` must be the
 * runner row as just re-read (under lock) by the caller. Checks, in order: revoked, the global pause, the
 * runner's pause, working hours (unattended only), max concurrency, personal subscriptions unattended, the
 * project's no-AI switch, and the project's monthly AI budget.
 */
export async function checkSafeguards(
  tx: Tx,
  rc: RunnerCtx,
  opts: { unattended: boolean; projectId: string; now: Date },
): Promise<ClaimRefusal | null> {
  const { runner } = rc
  // Authentication already refuses revoked runners; this catches a revoke between authentication and claim.
  if (runner.revokedAt) return 'runner_revoked'
  const [settings] = await tx.select().from(runnerSettings).where(eq(runnerSettings.id, 1))
  if (settings?.paused) return 'all_runners_paused'
  if (runner.paused) return 'runner_paused'
  if (opts.unattended && runner.workingHours && !withinWorkingHours(runner.workingHours, opts.now)) return 'outside_hours'
  const [active] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(eq(agentRuns.runnerId, runner.id), eq(agentRuns.state, 'running')))
  if ((active?.n ?? 0) >= runner.maxConcurrent) return 'at_capacity'
  if (opts.unattended && runner.accountType === 'personal-subscription' && !settings?.allowPersonalUnattended) {
    return 'personal_unattended_not_allowed'
  }
  const [project] = await tx.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, opts.projectId))
  if (!project || project.noAi) return 'no_ai'
  const usage = await monthUsage(tx, opts.projectId)
  if (usage.budgetUsd !== null && usage.costUsd >= usage.budgetUsd) return 'budget_exceeded'
  return null
}
