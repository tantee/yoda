import Fastify, { type FastifyInstance } from 'fastify'
import type { JWTVerifyGetKey } from 'jose'
import { ZodError } from 'zod'
import type { Config } from './config.js'
import type { Db } from './db/client.js'

export type AppDeps = { config: Config; db: Db; jwks: JWTVerifyGetKey }

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.VITEST ? false : true })
  app.decorate('deps', deps)

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', issues: err.issues })
    }
    return reply.send(err)
  })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
