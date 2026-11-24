import { createRemoteJWKSet } from 'jose'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { LiveBus } from './live/bus.js'
import { seedTemplates } from './workflow/seed.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
await seedTemplates(db)
const jwks = createRemoteJWKSet(
  new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`),
)
const app = await buildApp({ config, db, jwks, bus: new LiveBus() })

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
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
