import { MockLanguageModelV4 } from 'ai/test'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/client.js'
import { seedTemplates } from '../src/workflow/seed.js'
import { runMigrations } from '../src/db/migrate.js'
import type { AppDeps } from '../src/app.js'
import { createS3Storage, type Storage } from '../src/storage/s3.js'
import { createMemoryStorage } from '../src/storage/memory.js'
import { AiGateway } from '../src/ai/gateway.js'
import type { ModelSet } from '../src/ai/models.js'
import { LiveBus } from '../src/live/bus.js'
import { registerJobHandlers } from '../src/jobs/handlers.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { textStream } from './ai-mocks.js'
import { localJwks, TEST_CLIENT_ID, TEST_ISSUER } from './jwt.js'

// DEV ONLY: local docker-compose Postgres credentials
const DEFAULT_TEST_URL = 'postgres://yoda:yoda@localhost:5432/yoda_test'

let dbPromise: Promise<Db> | undefined

export function testDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const db = createDb(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL)
    await runMigrations(db)
    return db
  })()
  return dbPromise
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE notifications, proposals, conversation_reads, messages, conversations, ai_calls, knowledge_chunks, knowledge_entries, attachments, people, projects, project_members, events, tasks, work_items, workflow_templates CASCADE`)
  await seedTemplates(db)
}

// Unique key prefix per test process so runs never collide on the shared dev MinIO.
const TEST_PREFIX = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`
let storagePromise: Promise<Storage> | undefined
function testStorage(config: AppDeps['config']): Promise<Storage> {
  const useMemory = !process.env.S3_ENDPOINT || process.env.TEST_STORAGE === 'memory'
  storagePromise ??= useMemory ? Promise.resolve(createMemoryStorage()) : createS3Storage(config, { prefix: TEST_PREFIX })
  return storagePromise
}

/** Mock models: no network. Override `models` to inject specific mocks. */
export function mockModels(overrides: Partial<ModelSet> = {}): ModelSet {
  const lm = (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async () => ({ stream: textStream('ok') }),
    })
  return {
    draft: lm('claude-opus-5-5'),
    fast: lm('claude-haiku-5-5'),
    embed: null,
    ids: { draft: 'anthropic:claude-opus-5-5', fast: 'anthropic:claude-haiku-5-5', embed: null },
    ...overrides,
  }
}

export async function testDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const config: AppDeps['config'] = {
      port: 0,
      databaseUrl: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL,
      oidcIssuer: TEST_ISSUER,
      oidcClientId: TEST_CLIENT_ID,
      staffGroup: '/it-dev',
      bootstrapAdmins: [],
      aiModelDraft: 'anthropic:claude-opus-5-5',
      aiModelFast: 'anthropic:claude-haiku-5-5',
      // Real S3 is used only when S3_ENDPOINT is set (and TEST_STORAGE != memory); see testStorage.
      s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      s3Region: 'us-east-1',
      s3Bucket: 'yoda',
      s3AccessKey: process.env.S3_ACCESS_KEY ?? 'yoda', // DEV ONLY (docker-compose MinIO)
      s3SecretKey: process.env.S3_SECRET_KEY ?? 'yoda-dev-minio', // DEV ONLY
      aiWorkers: 2,
      dailyTaskCap: 8,
  }
  const db = await testDb()
  const bus = new LiveBus()
  const deps: AppDeps = {
    config,
    db,
    jwks: localJwks,
    bus,
    ai: new AiGateway({ db, bus, models: mockModels() }),
    storage: await testStorage(config),
    // Most tests drive AI tasks by hand, so drafting and secretary jobs are dropped by default; drafter and
    // chat tests that assert on them pass their own queue.
    jobs: new InlineJobQueue({
      onError: (err, name, id) => console.warn(`test job ${name} ${id} failed`, err),
      ignore: ['draft-task', 'secretary-chat'],
    }),
    ...overrides,
  }
  // Handlers see the final deps (overrides included). Tests await `(deps.jobs as InlineJobQueue).drain()`.
  await registerJobHandlers(deps)
  return deps
}
