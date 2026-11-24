import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import type { JWTVerifyGetKey } from 'jose'
import { ZodError } from 'zod'
import { HttpError, registerAuth } from './auth/plugin.js'
import { MAX_UPLOAD_BYTES } from './attachments/service.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import type { LiveBus } from './live/bus.js'
import type { AiGateway } from './ai/gateway.js'
import type { AttachmentStoredHook } from './attachments/service.js'
import type { JobQueue } from './jobs/queue.js'
import { createAttachmentEntry } from './knowledge/service.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { aiRoutes } from './routes/ai.js'
import { attachmentRoutes } from './routes/attachments.js'
import type { Storage } from './storage/s3.js'
import { peopleRoutes } from './routes/people.js'
import { projectRoutes } from './routes/projects.js'
import { meRoutes } from './routes/me.js'
import { streamRoutes } from './routes/stream.js'
import { workRoutes } from './routes/work.js'
import { requestRoutes } from './routes/requests.js'
import { chatRoutes } from './routes/chat.js'
import { proposalRoutes } from './routes/proposals.js'
import { notificationRoutes } from './routes/notifications.js'

export type AppDeps = {
  config: Config
  db: Db
  jwks: JWTVerifyGetKey
  bus: LiveBus
  storage: Storage
  ai: AiGateway
  jobs: JobQueue
  /** Replaces the default upload hook (create the attachment's knowledge entry); tests use it to observe calls. */
  onAttachmentStored?: AttachmentStoredHook
}

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
  requestRoutes(app)
  chatRoutes(app)
  proposalRoutes(app)
  notificationRoutes(app)
  streamRoutes(app)
  // Text-bearing uploads become `document` entries. The attachment is already committed, so a failure here
  // is logged rather than failing the upload (a retried upload would duplicate the file).
  const onStored: AttachmentStoredHook =
    deps.onAttachmentStored ??
    (async (row, text) => {
      try {
        await createAttachmentEntry(app.deps, row, text)
      } catch (err) {
        app.log.error({ err, attachmentId: row.id }, 'knowledge entry for attachment failed')
      }
    })
  attachmentRoutes(app, { onStored })
  aiRoutes(app)
  knowledgeRoutes(app)

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
