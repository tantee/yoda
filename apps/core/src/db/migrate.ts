import { fileURLToPath } from 'node:url'
import { createDb } from './client.js'
import { runMigrations } from './migrations.js'

export { runMigrations }

// CLI entry: `pnpm --filter @yoda/core db:migrate`, or `node dist/migrate.js` (the production `migrate` service).
// The server imports ./migrations.js instead, so bundling never pulls this entry check into dist/server.js.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const db = createDb(url)
  await runMigrations(db)
  console.log('migrations applied')
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end()
}
