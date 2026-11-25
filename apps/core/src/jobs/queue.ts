import { PgBoss } from 'pg-boss'

export type JobName = 'embed-entry' | 'draft-task' | 'secretary-chat' | 'secretary-event' | 'secretary-sweep' | 'discussion-brief'
export const JOB_NAMES: readonly JobName[] = [
  'embed-entry',
  'draft-task',
  'secretary-chat',
  'secretary-event',
  'secretary-sweep',
  'discussion-brief',
]

/** Recurring jobs (cron, Asia/Bangkok): pg-boss sends them; tests run them with `InlineJobQueue.runScheduled`. */
export const SCHEDULES: Partial<Record<JobName, string>> = { 'secretary-sweep': '*/15 * * * *' }

/** `attempt` starts at 1; with RETRY_LIMIT 2 the 3rd attempt is final. */
/** `signal` (pg-boss) aborts when the job expires or is cancelled; the inline test queue omits it. */
export type JobRun = { id: string; attempt: number; isFinalAttempt: boolean; signal?: AbortSignal }
export type JobHandler = (run: JobRun) => Promise<void>

export interface JobQueue {
  send(name: JobName, data: { id: string }): Promise<void>
  work(name: JobName, handler: JobHandler): Promise<void>
  stop(): Promise<void>
}

export const RETRY_LIMIT = 2
export const RETRY_DELAY_SECONDS = 30
export const EXPIRE_IN_SECONDS = 10 * 60

const QUEUE_OPTIONS = { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY_SECONDS, expireInSeconds: EXPIRE_IN_SECONDS }

/**
 * `draft-task` (singletonKey = task id) and `discussion-brief` (= discussion id) are sent on `exclusive`
 * queues, so at most one job per task / discussion is queued, retrying or active; a duplicate send is dropped
 * by pg-boss. The policy only applies when the queue is first created (pg-boss cannot change an existing
 * queue's policy).
 */
export const POLICY: Partial<Record<JobName, 'exclusive'>> = { 'draft-task': 'exclusive', 'discussion-brief': 'exclusive' }
export const SINGLETON: readonly JobName[] = ['draft-task', 'discussion-brief']

/** pg-boss backed queue (its own `pgboss` schema in the app database). Used only by server.ts. */
export async function createPgBossQueue(databaseUrl: string, concurrency: number): Promise<JobQueue> {
  const boss = new PgBoss(databaseUrl)
  boss.on('error', (err) => console.error('pg-boss error', err))
  await boss.start()
  for (const name of JOB_NAMES) {
    // createQueue is insert-if-absent; updateQueue applies changed retry settings to an existing queue.
    const policy = POLICY[name]
    await boss.createQueue(name, policy ? { ...QUEUE_OPTIONS, policy } : QUEUE_OPTIONS)
    await boss.updateQueue(name, QUEUE_OPTIONS)
  }
  for (const [name, cron] of Object.entries(SCHEDULES)) {
    // Insert-or-update by queue name, so every instance may call it on start.
    await boss.schedule(name, cron, { id: 'scheduled' }, { tz: 'Asia/Bangkok' })
  }
  return {
    async send(name, data) {
      await boss.send(name, data, SINGLETON.includes(name) ? { ...QUEUE_OPTIONS, singletonKey: data.id } : QUEUE_OPTIONS)
    },
    async work(name, handler) {
      await boss.work<{ id: string }>(name, { localConcurrency: concurrency, batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          await handler({
            id: job.data.id,
            attempt: job.retryCount + 1,
            isFinalAttempt: job.retryCount >= RETRY_LIMIT,
            signal: job.signal,
          })
        }
      })
    },
    async stop() {
      await boss.stop({ graceful: true })
    },
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
    for (let attempt = 1; attempt <= RETRY_LIMIT + 1; attempt++) {
      const isFinalAttempt = attempt === RETRY_LIMIT + 1
      try {
        await handler({ id, attempt, isFinalAttempt })
        return
      } catch (err) {
        if (isFinalAttempt) this.opts.onError?.(err, name, id)
      }
    }
  }
}
