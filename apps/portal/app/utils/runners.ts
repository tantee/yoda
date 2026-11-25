import { RunnerCapability, type AgentRunState, type Task, type WorkingHours } from '@yoda/shared'

const RUN_STATE: Record<AgentRunState, string> = {
  running: 'info',
  succeeded: 'success',
  failed: 'error',
  expired: 'warning',
  parked: 'warning',
  released: 'grey',
}

export function runStateColor(s: AgentRunState): string {
  return RUN_STATE[s] ?? 'grey'
}

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

const RUNNER_CAPS: readonly string[] = RunnerCapability.options

type WaitingTask = Pick<Task, 'executor' | 'assigneeId' | 'state' | 'aiStatus' | 'capability' | 'run'>

/**
 * What an open, unassigned AI task is waiting for: 'runner' for the capabilities runners work (unless a
 * run is going or parked, which the run chip shows), 'ai' for core's drafting; null when not waiting.
 */
export function waitingFor(t: WaitingTask): 'runner' | 'ai' | null {
  if (t.executor !== 'ai' || t.assigneeId || t.state !== 'open' || t.aiStatus) return null
  if (t.capability && RUNNER_CAPS.includes(t.capability)) {
    return t.run?.state === 'running' || t.run?.state === 'parked' ? null : 'runner'
  }
  return 'ai'
}
