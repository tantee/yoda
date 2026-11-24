import { PgBoss } from 'pg-boss'

export type JobName = 'embed-entry' | 'draft-task'
export const JOB_NAMES: readonly JobName[] = ['embed-entry', 'draft-task']

/** `attempt` starts at 1; with RETRY_LIMIT 2 the 3rd attempt is final. */
export type JobRun = { id: string; attempt: number; isFinalAttempt: boolean }
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

/** pg-boss backed queue (its own `pgboss` schema in the app database). Used only by server.ts. */
export async function createPgBossQueue(databaseUrl: string, concurrency: number): Promise<JobQueue> {
  const boss = new PgBoss(databaseUrl)
  boss.on('error', (err) => console.error('pg-boss error', err))
  await boss.start()
  for (const name of JOB_NAMES) {
    // createQueue is insert-if-absent; updateQueue applies changed retry settings to an existing queue.
    await boss.createQueue(name, QUEUE_OPTIONS)
    await boss.updateQueue(name, QUEUE_OPTIONS)
  }
  return {
    async send(name, data) {
      await boss.send(name, data, QUEUE_OPTIONS)
    },
    async work(name, handler) {
      await boss.work<{ id: string }>(name, { localConcurrency: concurrency, batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          await handler({
            id: job.data.id,
            attempt: job.retryCount + 1,
            isFinalAttempt: job.retryCount >= RETRY_LIMIT,
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
