import Fastify, { type FastifyInstance } from 'fastify'
import type { JWTVerifyGetKey } from 'jose'
import { ZodError } from 'zod'
import { HttpError, registerAuth } from './auth/plugin.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { LiveBus } from './live/bus.js'
import { peopleRoutes } from './routes/people.js'
import { projectRoutes } from './routes/projects.js'
import { meRoutes } from './routes/me.js'

export type AppDeps = { config: Config; db: Db; jwks: JWTVerifyGetKey; bus: LiveBus }

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.VITEST ? false : true })
  app.decorate('deps', deps)

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send(err.body)
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', issues: err.issues })
    }
    // Fastify-generated client errors (bad JSON, 404-ish, etc.) keep their status; no internals leak.
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: (err as { code?: string }).code ?? 'bad_request' })
    }
    app.log.error(err)
    return reply.status(500).send({ error: 'internal' })
  })

  registerAuth(app)

  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }))
  meRoutes(app)
  peopleRoutes(app)
  projectRoutes(app)

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
