import Fastify, { type FastifyInstance } from 'fastify'
import type { JWTVerifyGetKey } from 'jose'
import { ZodError } from 'zod'
import { HttpError, registerAuth } from './auth/plugin.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { peopleRoutes } from './routes/people.js'
import { projectRoutes } from './routes/projects.js'
import { meRoutes } from './routes/me.js'

export type AppDeps = { config: Config; db: Db; jwks: JWTVerifyGetKey }

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
    return reply.send(err)
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
