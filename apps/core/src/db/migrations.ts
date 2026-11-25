import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { Db } from './client.js'

// src/db/migrations.ts (dev/test) or dist/*.js (built image): find the drizzle folder either way.
const migrationsFolder = ['../../drizzle', '../drizzle']
  .map((p) => fileURLToPath(new URL(p, import.meta.url)))
  .find((p) => existsSync(p)) as string

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder })
}
