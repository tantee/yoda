import { buildApp } from './app.js'
import { remoteJwks } from './auth/jwks.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrations.js'
import { createS3Storage } from './storage/s3.js'
import { AiGateway } from './ai/gateway.js'
import { buildModels } from './ai/models.js'
import { LiveBus } from './live/bus.js'
import { registerJobHandlers } from './jobs/handlers.js'
import { createPgBossQueue } from './jobs/queue.js'
import { GitLabClient } from './gitlab/client.js'
import { seedTemplates } from './workflow/seed.js'
import { createMailTransport, emailConfigured } from './notifications/channels/email.js'
import { loadMasterKey } from './settings/crypto.js'
import { SettingsStore } from './settings/store.js'

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
// state shown on /health, not a crash. Consumers still read `config` for now.
const settings = await SettingsStore.open({ db, env: process.env, masterKey: loadMasterKey(process.env) })
if (settings.recovery) console.warn(`settings: recovery state (master key ${settings.keyStatus}); stored secrets unavailable`)
const jwks = remoteJwks(config)
const storage = await createS3Storage(config)
const bus = new LiveBus()
const jobs = await createPgBossQueue(config.databaseUrl, config.aiWorkers)
const ai = new AiGateway({ db, bus, models: buildModels(config), config, jobs })
const gitlab = config.gitlabUrl && config.gitlabToken ? new GitLabClient({ baseUrl: config.gitlabUrl, token: config.gitlabToken }) : null
// Caches the bot user for the webhook (which never calls GitLab); best effort, the admin status page retries it.
if (gitlab) void gitlab.currentUser().catch(() => console.warn('gitlab: bot user not resolved at boot (GitLab unreachable?)'))
const mailTransport = emailConfigured(config) ? createMailTransport(config) : undefined
const app = await buildApp({ config, db, jwks, bus, storage, ai, jobs, gitlab, mailTransport, settings })
await registerJobHandlers(app.deps)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    await jobs.stop()
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end()
    process.exit(0)
  } catch (err) {
    app.log.error(err, 'error during shutdown')
    process.exit(1)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ port: config.port, host: '0.0.0.0' })
