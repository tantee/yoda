import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb, pgClient } from './db/client.js'
import { runMigrations } from './db/migrations.js'
import { createS3Storage } from './storage/s3.js'
import { AiGateway } from './ai/gateway.js'
import { LiveBus } from './live/bus.js'
import { registerJobHandlers } from './jobs/handlers.js'
import { createPgBossQueue } from './jobs/queue.js'
import { seedTemplates } from './workflow/seed.js'
import { takeMasterKey } from './settings/crypto.js'
import { LiveSettings } from './settings/live.js'
import { SettingsStore } from './settings/store.js'

// Read the master key first and drop YODA_MASTER_KEY from process.env, so it does not linger there.
const masterKey = takeMasterKey(process.env)
const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
// Dev and a plain `docker run` migrate here; production compose sets MIGRATE_ON_START=false and runs the
// one-shot `migrate` service first, so only one container ever migrates.
if (config.migrateOnStart) {
  await runMigrations(db)
  console.log('migrations applied')
}
await seedTemplates(db)
// Imports env into the settings table (D4) and checks the master key; a missing or wrong key is a recovery
// state shown on /health, not a crash.
const settings = await SettingsStore.open({ db, env: process.env, masterKey })
if (settings.recovery) console.warn(`settings: recovery state (master key ${settings.keyStatus}); stored secrets unavailable`)
// Live apply (§5.3): `deps.config` and the clients built from settings (JWKS, AI models, GitLab, SMTP) follow
// every change, here or on another instance (NOTIFY), without a restart. Bootstrap-only values stay from env.
const live = new LiveSettings({ store: settings, base: config })
await live.listen()
const storage = await createS3Storage(config)
const bus = new LiveBus()
// Restart-mode: the worker count is read once, here (the store flags a later change as restart-required).
const jobs = await createPgBossQueue(config.databaseUrl, live.config.aiWorkers)
const ai = new AiGateway({
  db,
  bus,
  jobs,
  get models() {
    return live.models
  },
  get config() {
    return live.config
  },
})
const deps = live.attach({ db, bus, storage, ai, jobs, settings })
const app = await buildApp(deps)
await registerJobHandlers(app.deps)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    await live.close()
    await jobs.stop()
    await pgClient(db).end()
    process.exit(0)
  } catch (err) {
    app.log.error(err, 'error during shutdown')
    process.exit(1)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ port: config.port, host: '0.0.0.0' })
