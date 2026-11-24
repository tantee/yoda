import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/client.js'
import { seedTemplates } from '../src/workflow/seed.js'
import { runMigrations } from '../src/db/migrate.js'
import type { AppDeps } from '../src/app.js'
import { LiveBus } from '../src/live/bus.js'
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
  await db.execute(sql`TRUNCATE ai_calls, knowledge_chunks, knowledge_entries, attachments, people, projects, project_members, events, tasks, work_items, workflow_templates CASCADE`)
  await seedTemplates(db)
}

export async function testDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  return {
    config: {
      port: 0,
      databaseUrl: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL,
      oidcIssuer: TEST_ISSUER,
      oidcClientId: TEST_CLIENT_ID,
      staffGroup: '/it-dev',
      bootstrapAdmins: [],
      aiModelDraft: 'anthropic:claude-opus-5-5',
      aiModelFast: 'anthropic:claude-haiku-5-5',
      s3Endpoint: 'http://localhost:9000',
      s3Region: 'us-east-1',
      s3Bucket: 'yoda',
      s3AccessKey: 'yoda', // DEV ONLY (docker-compose MinIO)
      s3SecretKey: 'yoda-dev-minio', // DEV ONLY
      aiWorkers: 2,
    },
    db: await testDb(),
    jwks: localJwks,
    bus: new LiveBus(),
    ...overrides,
  }
}
