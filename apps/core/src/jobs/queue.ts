import { PgBoss } from 'pg-boss'

export type JobName = 'embed-entry' | 'draft-task' | 'secretary-chat' | 'secretary-event' | 'secretary-sweep' | 'discussion-brief' | 'gitlab-issue-sync' | 'gitlab-mr-effect' | 'gitlab-mr-reconcile' | 'runner-lease-sweep' | 'weekly-summary' | 'weekly-summary-project' | 'notify-deliver' | 'gitlab-env-sync' | 'defect-retention' | 'defect-orphan-sweep'
export const JOB_NAMES: readonly JobName[] = [
  'embed-entry',
  'draft-task',
  'secretary-chat',
  'secretary-event',
  'secretary-sweep',
  'discussion-brief',
  'gitlab-issue-sync',
  'gitlab-mr-effect',
  'gitlab-mr-reconcile',
  'runner-lease-sweep',
  'weekly-summary',
  'weekly-summary-project',
  'notify-deliver',
  'gitlab-env-sync',
  'defect-retention',
  'defect-orphan-sweep',
]

/** Recurring jobs (cron, Asia/Bangkok): pg-boss sends them; tests run them with `InlineJobQueue.runScheduled`. */
export const SCHEDULES: Partial<Record<JobName, string>> = {
  'secretary-sweep': '*/15 * * * *',
  'runner-lease-sweep': '* * * * *',
  'weekly-summary': '0 8 * * 1',
  // GitLab environments for Yoda Reporter URL mapping (webhooks keep them current between runs).
  'gitlab-env-sync': '30 3 * * *',
  // Yoda Reporter files: retention after the item closes, then objects a crashed upload left behind.
  'defect-retention': '0 3 * * *',
  'defect-orphan-sweep': '15 3 * * *',
}

/** `attempt` starts at 1; with RETRY_LIMIT 2 the 3rd attempt is final (`retryLimit(name)` per queue). */
/** `signal` (pg-boss) aborts when the job expires or is cancelled; the inline test queue omits it. */
export type JobRun = { id: string; attempt: number; isFinalAttempt: boolean; signal?: AbortSignal }
export type JobHandler = (run: JobRun) => Promise<void>

export interface JobQueue {
  send(name: JobName, data: { id: string }): Promise<void>
  work(name: JobName, handler: JobHandler): Promise<void>
  stop(): Promise<void>
  /** True while the queue is running (readiness). */
  started(): boolean
}

export const RETRY_LIMIT = 2
export const RETRY_DELAY_SECONDS = 30
export const EXPIRE_IN_SECONDS = 10 * 60

const QUEUE_OPTIONS = { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY_SECONDS, expireInSeconds: EXPIRE_IN_SECONDS }

/**
 * `draft-task` (singletonKey = task id) and `discussion-brief` (= discussion id) are sent on `exclusive`
 * queues, so at most one job per task / discussion is queued, retrying or active; a duplicate send is dropped
 * by pg-boss. `gitlab-issue-sync` (= work item id) is `stately`: one active and one queued per work item, so a
 * change made during a running sync is still picked up by the next one; `gitlab-mr-reconcile` (= work item id)
 * likewise, so the sweep and new code-change tasks never pile up reconciles of one item. `runner-lease-sweep` is
 * `exclusive` too, so a slow sweep never overlaps the next minute's. `weekly-summary-project`
 * (= `<projectId>:<week>`, with `:force` for a regenerate) is `exclusive`, so a restart re-sending the fan-out
 * never queues a second run of one project-week. `notify-deliver` (= notification id) is `exclusive`, so two
 * deliveries of one notification never run at once (its `sent` rows make a later re-run a no-op). The policy only applies when the
 * queue is first created (pg-boss cannot change an existing queue's policy).
 */
export const POLICY: Partial<Record<JobName, 'exclusive' | 'stately'>> = {
  'draft-task': 'exclusive',
  'discussion-brief': 'exclusive',
  'gitlab-issue-sync': 'stately',
  'gitlab-mr-reconcile': 'stately',
  'runner-lease-sweep': 'exclusive',
  'weekly-summary': 'exclusive',
  'weekly-summary-project': 'exclusive',
  'notify-deliver': 'exclusive',
}
export const SINGLETON: readonly JobName[] = ['draft-task', 'discussion-brief', 'gitlab-issue-sync', 'gitlab-mr-reconcile', 'weekly-summary-project', 'notify-deliver']

/** Retries of an outside-channel delivery: about 30 s, doubling up to about 16 minutes (roughly 30 min in all). */
export const NOTIFY_RETRY_LIMIT = 6
const NOTIFY_RETRY_DELAY_MAX_SECONDS = 16 * 60

/**
 * Per-queue retry overrides. Outside channels ride out a short SMTP / LINE / Telegram outage: 6 retries with
 * exponential backoff (pg-boss: 30 s × 2^n with jitter, capped at 16 minutes). Delivery is at least once after
 * the job is queued; an outage longer than this window drops the message for that channel (the feed keeps it).
 */
const QUEUE_OVERRIDES: Partial<Record<JobName, { retryLimit: number; retryBackoff: boolean; retryDelayMax: number }>> = {
  'notify-deliver': { retryLimit: NOTIFY_RETRY_LIMIT, retryBackoff: true, retryDelayMax: NOTIFY_RETRY_DELAY_MAX_SECONDS },
}
const queueOptions = (name: JobName) => ({ ...QUEUE_OPTIONS, ...QUEUE_OVERRIDES[name] })
/** Retries after the first attempt for jobs of `name`. */
export const retryLimit = (name: JobName): number => QUEUE_OVERRIDES[name]?.retryLimit ?? RETRY_LIMIT

/** pg-boss backed queue (its own `pgboss` schema in the app database). Used only by server.ts. */
export async function createPgBossQueue(databaseUrl: string, concurrency: number): Promise<JobQueue> {
  const boss = new PgBoss(databaseUrl)
  boss.on('error', (err) => console.error('pg-boss error', err))
  await boss.start()
  let running = true
  for (const name of JOB_NAMES) {
    // createQueue is insert-if-absent; updateQueue applies changed retry settings to an existing queue.
    const policy = POLICY[name]
    await boss.createQueue(name, policy ? { ...queueOptions(name), policy } : queueOptions(name))
    await boss.updateQueue(name, queueOptions(name))
  }
  for (const [name, cron] of Object.entries(SCHEDULES)) {
    // Insert-or-update by queue name, so every instance may call it on start.
    await boss.schedule(name, cron, { id: 'scheduled' }, { tz: 'Asia/Bangkok' })
  }
  return {
    async send(name, data) {
      await boss.send(name, data, SINGLETON.includes(name) ? { ...queueOptions(name), singletonKey: data.id } : queueOptions(name))
    },
    async work(name, handler) {
      await boss.work<{ id: string }>(name, { localConcurrency: concurrency, batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          await handler({
            id: job.data.id,
            attempt: job.retryCount + 1,
            isFinalAttempt: job.retryCount >= retryLimit(name),
            signal: job.signal,
          })
        }
      })
    },
    async stop() {
      running = false
      await boss.stop({ graceful: true })
    },
    started: () => running,
  }
}

/**
 * In-process queue for tests: a sent job starts on the next tick (callers send after commit), with the same
 * retry semantics as pg-boss but no delays. A final-attempt failure is reported to `onError` and swallowed.
 */
export class InlineJobQueue implements JobQueue {
  private handlers = new Map<JobName, JobHandler>()
  private pending = new Set<Promise<void>>()

  constructor(
    private opts: {
      onError?: (err: unknown, name: JobName, id: string) => void
      /** Jobs dropped on send (tests that drive AI tasks by hand keep the drafter out of the way). */
      ignore?: readonly JobName[]
    } = {},
  ) {}

  async send(name: JobName, data: { id: string }): Promise<void> {
    if (this.opts.ignore?.includes(name)) return
    const p = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.run(name, data.id))
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  async work(name: JobName, handler: JobHandler): Promise<void> {
    this.handlers.set(name, handler)
  }

  async stop(): Promise<void> {
    await this.drain()
  }

  started(): boolean {
    return true
  }

  /** Runs a recurring job once, as pg-boss would at its cron time (tests). */
  async runScheduled(name: JobName): Promise<void> {
    await this.run(name, 'scheduled')
  }

  /** Resolves once every sent job (including jobs sent by running jobs) has finished. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private async run(name: JobName, id: string): Promise<void> {
    const handler = this.handlers.get(name)
    if (!handler) return
    const attempts = retryLimit(name) + 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const isFinalAttempt = attempt === attempts
      try {
        await handler({ id, attempt, isFinalAttempt })
        return
      } catch (err) {
        if (isFinalAttempt) this.opts.onError?.(err, name, id)
      }
    }
  }
}
