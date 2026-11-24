import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import type { JWTVerifyGetKey } from 'jose'
import { ZodError } from 'zod'
import { HttpError, registerAuth } from './auth/plugin.js'
import { MAX_UPLOAD_BYTES } from './attachments/service.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { LiveBus } from './live/bus.js'
import { attachmentRoutes } from './routes/attachments.js'
import type { Storage } from './storage/s3.js'
import { peopleRoutes } from './routes/people.js'
import { projectRoutes } from './routes/projects.js'
import { meRoutes } from './routes/me.js'
import { streamRoutes } from './routes/stream.js'
import { workRoutes } from './routes/work.js'

export type AppDeps = { config: Config; db: Db; jwks: JWTVerifyGetKey; bus: LiveBus; storage: Storage }

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
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    throwFileSizeLimit: true,
    // Not in the plugin's typings, but forwarded to busboy: keeps UTF-8 (Thai) file names intact.
    ...({ defParamCharset: 'utf8' } as object),
  })

  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }))
  meRoutes(app)
  peopleRoutes(app)
  projectRoutes(app)
  workRoutes(app)
  streamRoutes(app)
  attachmentRoutes(app)

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
