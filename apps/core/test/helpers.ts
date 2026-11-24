import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import type { JWTVerifyGetKey } from 'jose'
import type { AppDeps } from '../src/app.js'

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
  await db.execute(sql`TRUNCATE people, projects, project_members CASCADE`)
}

export async function testDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const jwks: JWTVerifyGetKey = async () => {
    throw new Error('placeholder jwks: replaced by local JWKS in Task 4')
  }
  return {
    config: {
      port: 0,
      databaseUrl: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL,
      oidcIssuer: 'http://issuer.test',
      oidcClientId: 'yoda-portal',
      staffGroup: '/it-dev',
      bootstrapAdmins: [],
    },
    db: await testDb(),
    jwks,
    ...overrides,
  }
}
