import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
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
import type { GitLabClient } from './gitlab/client.js'
import type { MailTransport } from './notifications/channels/email.js'
import type { SettingsStore } from './settings/store.js'
import { isInternalAddress, type OutboundPolicy } from './settings/outbound.js'
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
import { discussionRoutes } from './routes/discussions.js'
import { notificationRoutes } from './routes/notifications.js'
import { adminRoutes } from './routes/admin.js'
import { adminSettingsRoutes } from './routes/admin-settings.js'
import { gitlabRoutes } from './routes/gitlab.js'
import { runnerRoutes } from './routes/runners.js'
import { statusRoutes } from './routes/status.js'
import { shellRoutes } from './routes/shell.js'
import { mcpRoutes } from './routes/mcp.js'
import { notificationChannelRoutes } from './routes/notification-channels.js'
import { channelWebhookRoutes } from './routes/channel-webhooks.js'
import { publicConfigRoutes } from './routes/public-config.js'
import { setupRoutes } from './routes/setup.js'
import { setupWizardRoutes } from './routes/setup-wizard.js'
import { recoveryRoutes } from './routes/recovery.js'
import { extensionRoutes } from './routes/extension.js'
import type { ProxyProbe } from './proxy-status.js'
import { readiness } from './readiness.js'
import { VERSION } from './version.js'

export type AppDeps = {
  /**
   * The current settings, typed as Config. In server.ts this is a getter over the live snapshot (settings/live.ts),
   * as are `jwks`, `gitlab` and `mailTransport`: read each once at the start of a call and keep the reference.
   */
  config: Config
  db: Db
  jwks: JWTVerifyGetKey
  bus: LiveBus
  storage: Storage
  ai: AiGateway
  jobs: JobQueue
  /** Null when GITLAB_URL / GITLAB_TOKEN are not both set. */
  gitlab: GitLabClient | null
  /** SMTP transport for the email channel (server.ts builds it when SMTP is configured; tests inject a fake). */
  mailTransport?: MailTransport
  /**
   * Settings resolved env > database > default, with encrypted secrets (server.ts opens it at boot); `config` is
   * its snapshot. Optional so tests without it are unchanged.
   */
  settings?: SettingsStore
  /** The settings tests' outbound rules (`safeOutbound`); server.ts allows loopback outside production (dev fakes). */
  outbound?: OutboundPolicy
  /** The Anthropic API base for the AI settings test; tests point it at a fake. */
  anthropicUrl?: string
  /** The TLS handshake behind the wizard's built-in proxy card (proxy-status.ts); tests inject a fake. */
  proxyProbe?: ProxyProbe
  /** The clock (tests move it); defaults to the system time. */
  now?: () => Date
  /** Where the setup token is written (0600, the core-only bootstrap directory); null or unset: log only. */
  setupTokenFile?: string | null
  /** Replaces the default upload hook (create the attachment's knowledge entry); tests use it to observe calls. */
  onAttachmentStored?: AttachmentStoredHook
}

/**
 * Pino options. Request logs carry no headers today; credentials are redacted anyway, should a serializer or a
 * log call ever include them (Keycloak and runner bearer tokens, the GitLab and Telegram webhook secrets, the
 * LINE signature, cookies).
 */
export const LOGGER_OPTIONS = {
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-gitlab-token"]',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'req.headers["x-line-signature"]',
      'req.headers.cookie',
      'req.headers["x-yoda-csrf"]',
      'headers.authorization',
      'headers["x-gitlab-token"]',
      'headers["x-telegram-bot-api-secret-token"]',
      'headers["x-line-signature"]',
      'headers.cookie',
      'headers["x-yoda-csrf"]',
      // Settings saves and tests carry secrets in their bodies; bodies are not logged, and never should be.
      'req.body',
      'body.changes',
      'body.values',
      // Yoda Reporter: refresh tokens, codes and PKCE verifiers in /extension/token bodies; the idempotency key.
      'body.refreshToken',
      'body.code',
      'body.codeVerifier',
      'req.headers["idempotency-key"]',
      'headers["idempotency-key"]',
    ],
    censor: '[redacted]',
  },
} satisfies Exclude<FastifyServerOptions['logger'], boolean | undefined>

/**
 * The client address and scheme come from X-Forwarded-For / -Proto only when the direct peer is internal (the
 * portal's /api proxy on the compose network, or loopback), and only `hops` entries deep
 * (YODA_TRUSTED_PROXY_HOPS): each trusted proxy appends the address it saw, so with 1 (the portal alone) the
 * address the portal saw counts, with 2 (a reverse proxy in front of the portal) the one the reverse proxy saw.
 * Entries further left are the client's own and never believed, so it cannot choose its address for the rate
 * limits, the audit log and the alerts.
 */
export function trustProxy(hops = 1): (address: string, hop: number) => boolean {
  return (address, hop) => (hop === 0 ? isInternalAddress(address) : hop < hops)
}

/**
 * A proxy in front of the portal while YODA_TRUSTED_PROXY_HOPS is 1: the request came from the portal (an internal
 * peer) with more than one X-Forwarded-For entry, so something before the portal added one (or a browser sent its
 * own). Core then sees every client as the reverse proxy's address; the admin should set the variable to 2.
 */
export function outerProxyHint(peer: string, forwardedFor: string | string[] | undefined, hops: number): boolean {
  if (hops !== 1 || !isInternalAddress(peer)) return false
  const xff = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '')
  return xff.split(',').filter((e) => e.trim()).length > 1
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const hops = deps.config.trustedProxyHops ?? 1
  const app = Fastify({ logger: process.env.VITEST ? false : LOGGER_OPTIONS, trustProxy: trustProxy(hops) })
  app.decorate('deps', deps)
  let proxyWarned = false
  app.addHook('onRequest', async (request) => {
    if (proxyWarned || !outerProxyHint(request.socket.remoteAddress ?? '', request.headers['x-forwarded-for'], hops)) return
    proxyWarned = true
    request.log.warn(
      'requests arrive through a proxy in front of the portal (more than one X-Forwarded-For entry) while YODA_TRUSTED_PROXY_HOPS=1: client addresses show as the proxy. Set YODA_TRUSTED_PROXY_HOPS=2 (docs/operations.md, upgrade notes).',
    )
  })

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

  // Liveness: the process answers. Readiness: its database, storage and queue answer too (load balancers, compose).
  // With the settings store, health also shows the master key state, so a wrong or missing key is visible.
  app.get('/health', { config: { public: true, setupMode: true } }, async () => ({
    status: 'ok',
    version: VERSION,
    ...(deps.settings ? { settings: { secrets: deps.settings.keyStatus, recovery: deps.settings.recovery } } : {}),
  }))
  app.get('/ready', { config: { public: true, setupMode: true } }, async (_req, reply) => {
    const r = await readiness(app.deps)
    return reply.status(r.ok ? 200 : 503).send({ status: r.ok ? 'ok' : 'unavailable', checks: r.checks })
  })
  publicConfigRoutes(app)
  setupRoutes(app)
  setupWizardRoutes(app)
  recoveryRoutes(app)
  meRoutes(app)
  peopleRoutes(app)
  projectRoutes(app)
  workRoutes(app)
  requestRoutes(app)
  chatRoutes(app)
  proposalRoutes(app)
  discussionRoutes(app)
  notificationRoutes(app)
  notificationChannelRoutes(app)
  channelWebhookRoutes(app)
  adminRoutes(app)
  adminSettingsRoutes(app)
  gitlabRoutes(app)
  runnerRoutes(app)
  statusRoutes(app)
  shellRoutes(app)
  if (deps.config.mcpEnabled) mcpRoutes(app)
  extensionRoutes(app)
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
