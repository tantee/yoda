import { SETTINGS, type SettingKey, type SettingValue } from '@yoda/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError, notFound, setupRequired } from '../auth/plugin.js'
import { setupState } from '../setup-state.js'
import { authenticateExtension, effectiveAllowedIds, type GrantRow } from './grants.js'
import type { Me } from '@yoda/shared'

/** How an `/extension/*` route authenticates (plan A3). */
export type ExtensionMode = 'token' | 'public' | 'keycloak'

/** An extension setting: env > database > registry default (tests may run without a store). */
export function extensionSetting<K extends Extract<SettingKey, `extension.${string}`>>(
  settings: FastifyInstance['deps']['settings'],
  key: K,
): SettingValue<K> {
  const v = settings?.get(key)
  return (v ?? SETTINGS[key].default) as SettingValue<K>
}

/** The grant ttl and allowlist, read once per call. */
export function grantSettings(settings: FastifyInstance['deps']['settings']) {
  return {
    allowedIds: effectiveAllowedIds({ get: () => extensionSetting(settings, 'extension.allowedIds') }),
    ttl: {
      accessMinutes: extensionSetting(settings, 'extension.accessTtlMinutes'),
      idleDays: extensionSetting(settings, 'extension.refreshIdleDays'),
      absoluteDays: extensionSetting(settings, 'extension.refreshAbsoluteDays'),
      reauthDays: extensionSetting(settings, 'extension.reauthDays'),
    },
  }
}

/**
 * The gate every route with `config.extension` passes, at the start of the auth hook: setup mode (503
 * `setup_required`), forced recovery mode (503 `recovery_mode`), `extension.enabled` off (404, before any token is
 * read), then for `token` routes a `yoda_xt_` access token only. Returns true when the auth hook is done with the
 * request (`token` and `public`); `keycloak` routes fall through to the normal Keycloak check.
 */
export async function extensionGate(app: FastifyInstance, request: FastifyRequest, mode: ExtensionMode): Promise<boolean> {
  const { deps } = app
  if (request.routeOptions.config?.setupMode !== true && setupState(deps.config, deps.settings) === 'required') throw setupRequired()
  if (deps.settings?.recoveryForced) throw new HttpError(503, { error: 'recovery_mode' })
  if (!extensionSetting(deps.settings, 'extension.enabled')) throw notFound()
  if (mode === 'keycloak') return false
  if (mode === 'public') return true
  const now = deps.now?.() ?? new Date()
  const found = await authenticateExtension(deps.db, request.headers.authorization, {
    now,
    allowedIds: grantSettings(deps.settings).allowedIds,
    ip: request.ip,
  })
  if (!found) throw new HttpError(401, { error: 'unauthorized' })
  request.extension = found
  return true
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The grant and person of an `/extension/*` token route (null elsewhere). */
    extension: { grant: GrantRow; me: Me } | null
  }
}
