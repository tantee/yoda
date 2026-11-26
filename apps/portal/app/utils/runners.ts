import { RunnerCapability, type Runner, type Task, type WorkingHours } from '@yoda/shared'

/** Bangkok has no daylight saving: UTC+7 all year. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

/**
 * Whether `now` falls in the runner's working hours, in Asia/Bangkok (days 0 = Sunday to 6; start
 * inclusive, end exclusive; the window never crosses midnight). No window means any time.
 * Only for the portal's "outside working hours" hint: core decides claims.
 */
export function withinHours(h: WorkingHours | null, now: Date): boolean {
  if (!h) return true
  const bkk = new Date(now.getTime() + BANGKOK_OFFSET_MS)
  if (!h.days.includes(bkk.getUTCDay())) return false
  const hhmm = `${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')}`
  return hhmm >= h.start && hhmm < h.end
}

/** Whole minutes since a run's last heartbeat. */
export function heartbeatAgeMinutes(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000))
}

export type RunnerStatus = 'active' | 'paused' | 'revoked'

export function runnerStatus(r: Pick<Runner, 'paused' | 'revokedAt'>): RunnerStatus {
  return r.revokedAt ? 'revoked' : r.paused ? 'paused' : 'active'
}

/** Revoked runners last (proposal §8.2 runners); otherwise the server order. */
export function sortRunners<T extends Pick<Runner, 'paused' | 'revokedAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt))
}

const RUNNER_CAPS: readonly string[] = RunnerCapability.options

type WaitingTask = Pick<Task, 'executor' | 'assigneeId' | 'state' | 'aiStatus' | 'capability' | 'run' | 'parked'>

/**
 * What an open, unassigned AI task is waiting for: 'runner' for the capabilities runners work (unless a run
 * is going, or parked on a question still open, which the run chip shows), 'ai' for core's drafting; null when
 * not waiting. A parked run whose question was decided waits for a runner again; without `parked` (an older
 * core) a parked run counts as still waiting on its question.
 */
export function waitingFor(t: WaitingTask): 'runner' | 'ai' | null {
  if (t.executor !== 'ai' || t.assigneeId || t.state !== 'open' || t.aiStatus) return null
  if (t.capability && RUNNER_CAPS.includes(t.capability)) {
    if (t.run?.state === 'running') return null
    if (t.run?.state === 'parked' && t.parked !== false) return null
    return 'runner'
  }
  return 'ai'
}
