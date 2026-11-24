import { createRemoteJWKSet } from 'jose'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig(process.env)
const db = createDb(config.databaseUrl)
const jwks = createRemoteJWKSet(
  new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`),
)
const app = await buildApp({ config, db, jwks })
await app.listen({ port: config.port, host: '0.0.0.0' })
