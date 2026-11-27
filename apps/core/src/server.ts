// First: drops empty AI base URLs before the AI SDK is imported (env-preload.ts).
import './env-preload.js'
import { buildApp } from './app.js'
import { applyBootstrapFile, loadConfig } from './config.js'
import { createDb, pgClient } from './db/client.js'
import { runMigrations } from './db/migrations.js'
import { createS3Storage } from './storage/s3.js'
import { AiGateway } from './ai/gateway.js'
import { LiveBus } from './live/bus.js'
import { registerJobHandlers } from './jobs/handlers.js'
import { createPgBossQueue } from './jobs/queue.js'
import { seedTemplates } from './workflow/seed.js'
import { takeMasterKeySetup } from './settings/crypto.js'
import { LiveSettings } from './settings/live.js'
import { SettingsStore } from './settings/store.js'
import { internalAddresses } from './settings/outbound.js'
import { keycloakMismatch } from './routes/public-config.js'
import { issueSetupToken, setupTokenFile } from './local/setup-token.js'
import { setupState } from './setup-state.js'

// The bundled stack's DATABASE_URL and S3 keys come from the bootstrap volume (the `init` service) when env leaves
// them empty; env always wins.
applyBootstrapFile(process.env)

// Read the master key first and drop YODA_MASTER_KEY from process.env, so it does not linger there.
const key = takeMasterKeySetup(process.env)
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
const settings = await SettingsStore.open({ db, env: process.env, masterKey: key.masterKey, previousKey: key.previousKey, keyLoader: key.keyLoader })
// §12 T14: which values env forces (names only), so nobody wonders why the UI shows them locked.
if (settings.envLockedNames.length) console.log(`settings: set by environment (locked in System settings): ${settings.envLockedNames.join(', ')}`)
// On a stale key file (runsOnPreviousKey) the store has already said to fix .env; --finish would refuse then.
if (settings.previousKeyId && !settings.runsOnPreviousKey) console.warn(`settings: the previous master key ${settings.previousKeyId} is still loaded; finish the rotation with yoda-admin rotate-master-key --finish`)
if (settings.recovery) console.warn(`settings: recovery state (master key ${settings.keyStatus}); stored secrets unavailable`)
// Live apply (§5.3): `deps.config` and the clients built from settings (JWKS, AI models, GitLab, SMTP) follow
// every change, here or on another instance (NOTIFY), without a restart. Bootstrap-only values stay from env.
const live = new LiveSettings({ store: settings, base: config, client: pgClient(db) })
await live.listen()
// §6.4: the portal still prefers NUXT_PUBLIC_KEYCLOAK_* when set; if they disagree with the issuer core checks
// tokens against, every sign-in loops. Say so loudly (URLs and names only; nothing here is secret).
const mismatch = keycloakMismatch(process.env, live.config)
if (mismatch.length) {
  console.error(
    `config: ${mismatch.join(', ')} disagree with OIDC_ISSUER / OIDC_CLIENT_ID (${live.config.oidcIssuer}, ${live.config.oidcClientId}). ` +
      'The portal signs in with the NUXT_PUBLIC_* values and core rejects the tokens: remove them (the portal reads /public-config) or fix them.',
  )
}
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
// Settings tests reach loopback only with YODA_OUTBOUND_ALLOW_LOOPBACK=true (dev: the fakes on 127.0.0.1), and
// never core's own addresses or the compose services' (looked up once, best effort).
const outbound = { allowLoopback: settings.get('security.outboundAllowLoopback') === true, blockedAddresses: await internalAddresses() }
// Setup mode (§4.1, §8.2): a new setup token on every start until setup is done, in the log and the 0600 file.
const tokenFile = setupTokenFile(process.env)
if (setupState(live.config, settings) === 'required') await issueSetupToken(db, { file: tokenFile, now: new Date() })
const deps = live.attach({ db, bus, storage, ai, jobs, settings, outbound, setupTokenFile: tokenFile })
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
