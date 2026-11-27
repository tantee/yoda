import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HttpError } from '../auth/plugin.js'
import type { SettingsStore } from '../settings/store.js'
import type { RateLimiter } from '../settings/rate-limit.js'

/** Shared bits of the setup and recovery routes. */

export const nowOf = (app: FastifyInstance): Date => app.deps.now?.() ?? new Date()

export function storeOf(app: FastifyInstance): SettingsStore {
  const s = app.deps.settings
  if (!s) throw new HttpError(503, { error: 'settings_unavailable' })
  return s
}

export function takeLimit(limiter: RateLimiter, key: string, reply: FastifyReply): void {
  const r = limiter.take(key)
  if (!r.ok) {
    reply.header('retry-after', String(r.retryAfter))
    throw new HttpError(429, { error: 'rate_limited', retryAfter: r.retryAfter })
  }
}

export const secretsUnavailable = () => new HttpError(409, { error: 'secrets_unavailable' })
export const weakPassword = (reason: string) => new HttpError(422, { error: 'weak_password', reason })
export const secondFactorRequired = () => new HttpError(401, { error: 'second_factor_required' })
export const invalidCode = () => new HttpError(401, { error: 'invalid_code' })
export const invalidCredentials = () => new HttpError(401, { error: 'invalid_credentials' })

/** The request's audit fields. */
export const whereFrom = (request: FastifyRequest) => ({ ip: request.ip, requestId: String(request.id) })
