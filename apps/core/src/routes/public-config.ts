import { createHash } from 'node:crypto'
import { EXTENSION_API_VERSION, PublicConfig, settingDef, type SettingKey } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { setupState } from '../setup-state.js'
import { VERSION } from '../version.js'
import { funMode } from './admin.js'
import { extensionSetting } from '../extension/hook.js'

/** `<url>/realms/<realm>`, the Keycloak issuer form; any other issuer gives null (keycloak-js needs url + realm). */
export function keycloakFromIssuer(issuer: string | undefined): { url: string; realm: string } | null {
  const m = issuer ? /^(https?:\/\/[^?#]+?)\/realms\/([^/?#]+)\/*$/.exec(issuer) : null
  return m ? { url: m[1]!, realm: decodeURIComponent(m[2]!) } : null
}

/** Why an issuer cannot be used for portal sign-in (null when it can): keycloak-js needs `<url>/realms/<realm>`. */
export const NOT_KEYCLOAK_ISSUER = 'must be a Keycloak issuer, https://<host>/realms/<realm> (the portal signs in with Keycloak)'
export function issuerIssue(issuer: unknown): string | null {
  return typeof issuer === 'string' && issuer !== '' && !keycloakFromIssuer(issuer) ? NOT_KEYCLOAK_ISSUER : null
}

// Re-exported: setup-mode gating (503 setup_required, auth/plugin.ts) and the portal read the same function.
export { setupState }

const trim = (s: string) => s.replace(/\/+$/, '')

/**
 * §6.4: the deprecated NUXT_PUBLIC_KEYCLOAK_* (still honoured by the portal) against core's issuer and client id.
 * Returns the variables that disagree; a disagreement means the portal signs in at one realm while core checks
 * tokens against another (a sign-in loop). Unset variables are not compared.
 */
export function keycloakMismatch(env: NodeJS.ProcessEnv, config: Pick<Config, 'oidcIssuer' | 'oidcClientId'>): string[] {
  if (!config.oidcIssuer) return []
  const kc = keycloakFromIssuer(config.oidcIssuer)
  const out: string[] = []
  const url = env.NUXT_PUBLIC_KEYCLOAK_URL
  const realm = env.NUXT_PUBLIC_KEYCLOAK_REALM
  if (url && (!kc || trim(url) !== kc.url)) out.push('NUXT_PUBLIC_KEYCLOAK_URL')
  if (realm && (!kc || realm !== kc.realm)) out.push('NUXT_PUBLIC_KEYCLOAK_REALM')
  const clientId = env.NUXT_PUBLIC_KEYCLOAK_CLIENT_ID
  if (clientId && clientId !== config.oidcClientId) out.push('NUXT_PUBLIC_KEYCLOAK_CLIENT_ID')
  return out
}

/** A portal setting (env > database > default); unset or empty is null. These are never secret. */
function value(settings: AppDeps['settings'], key: PortalKey): string | null {
  const v: unknown = settings ? settings.get(key) : settingDef(key).default
  return typeof v === 'string' && v !== '' ? v : null
}

type PortalKey = Extract<SettingKey, 'org.name' | 'org.nameEn' | 'org.line' | 'org.defaultLocale' | 'org.runnerDocsUrl' | 'line.addFriendUrl'>

/**
 * Fun mode for an unauthenticated route, read from the database at most once per `ttlMs` (an anonymous caller
 * cannot make every request a query). A failed read counts as off and is not cached.
 */
export function funModeCache(read: (db: Db) => Promise<boolean> = funMode, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 5000
  const now = opts.now ?? Date.now
  let cached: { value: boolean; at: number } | null = null
  return async (db: Db): Promise<boolean> => {
    if (cached && now() - cached.at < ttl) return cached.value
    try {
      cached = { value: await read(db), at: now() }
      return cached.value
    } catch {
      return false
    }
  }
}

/** True when an If-None-Match header (a list, weak or strong tags, or `*`) matches the entity tag. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const bare = (t: string) => t.trim().replace(/^W\//, '')
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag))
}

/** The public config from the current settings snapshot. Fun mode unknown (database down) counts as off. */
export async function buildPublicConfig(
  deps: Pick<AppDeps, 'config' | 'settings' | 'db'>,
  readFunMode: (db: Db) => Promise<boolean> = funModeCache(),
): Promise<PublicConfig> {
  const config = deps.config
  const kc = keycloakFromIssuer(config.oidcIssuer)
  const fun = await readFunMode(deps.db)
  const s = deps.settings
  return PublicConfig.parse({
    oidc: kc ? { ...kc, clientId: config.oidcClientId } : null,
    org: {
      name: value(s, 'org.name'),
      nameEn: value(s, 'org.nameEn'),
      line: value(s, 'org.line'),
      defaultLocale: value(s, 'org.defaultLocale') ?? 'th',
    },
    runnerDocsUrl: value(s, 'org.runnerDocsUrl'),
    line: { addFriendUrl: value(s, 'line.addFriendUrl') },
    funMode: fun,
    setup: setupState(config, s),
    recovery: s?.recovery ?? false,
    recoveryForced: s?.recoveryForced ?? false,
    version: VERSION,
    extension: {
      enabled: extensionSetting(s, 'extension.enabled'),
      apiVersion: EXTENSION_API_VERSION,
      mediaRetentionDays: extensionSetting(s, 'extension.mediaRetentionDays'),
      logRetentionDays: extensionSetting(s, 'extension.logRetentionDays'),
      publicUrl: config.portalUrl,
    },
  })
}

/**
 * `GET /public-config` (§5.6): public, so the portal can read it before keycloak-js starts. Revalidated on every
 * use (`no-cache` with an ETag), so a just-finished setup is never hidden behind a cached `setup: 'required'`.
 */
export function publicConfigRoutes(app: FastifyInstance): void {
  const fun = funModeCache()
  app.get('/public-config', { config: { public: true, setupMode: true } }, async (request, reply) => {
    const body = JSON.stringify(await buildPublicConfig(app.deps, fun))
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
    reply.header('cache-control', 'no-cache').header('etag', etag)
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.status(304).send()
    return reply.type('application/json; charset=utf-8').send(body)
  })
}
