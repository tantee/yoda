import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb, type Db } from './client.js'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder })
}

// CLI entry: `pnpm --filter @yoda/core db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const db = createDb(url)
  await runMigrations(db)
  console.log('migrations applied')
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end()
}
