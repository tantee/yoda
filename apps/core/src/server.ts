import { createRemoteJWKSet } from 'jose'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { createS3Storage } from './storage/s3.js'
import { AiGateway } from './ai/gateway.js'
import { buildModels } from './ai/models.js'
import { LiveBus } from './live/bus.js'
import { registerJobHandlers } from './jobs/handlers.js'
import { createPgBossQueue } from './jobs/queue.js'
import { GitLabClient } from './gitlab/client.js'
import { seedTemplates } from './workflow/seed.js'
import { createMailTransport, emailConfigured } from './notifications/channels/email.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
await seedTemplates(db)
const jwks = createRemoteJWKSet(
  new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`),
)
const storage = await createS3Storage(config)
const bus = new LiveBus()
const jobs = await createPgBossQueue(config.databaseUrl, config.aiWorkers)
const ai = new AiGateway({ db, bus, models: buildModels(config), config, jobs })
const gitlab = config.gitlabUrl && config.gitlabToken ? new GitLabClient({ baseUrl: config.gitlabUrl, token: config.gitlabToken }) : null
// Caches the bot user for the webhook (which never calls GitLab); best effort, the admin status page retries it.
if (gitlab) void gitlab.currentUser().catch(() => console.warn('gitlab: bot user not resolved at boot (GitLab unreachable?)'))
const mailTransport = emailConfigured(config) ? createMailTransport(config) : undefined
const app = await buildApp({ config, db, jwks, bus, storage, ai, jobs, gitlab, mailTransport })
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
