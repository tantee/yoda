import type { PublicConfig } from '@yoda/shared'

/**
 * Portal boot (installer proposal §4.1, §5.6; spike §2): the portal reads core's `GET /api/public-config` before
 * keycloak-js starts. These are the pure decisions; plugins/keycloak.client.ts does the I/O.
 */

/** Pages that never touch Keycloak, so they work while sign-in is unset, wrong or down (spike §2.3). */
const LOCAL_AUTH_PREFIXES = ['/setup', '/recovery']

export function isLocalAuthPath(path: string): boolean {
  return LOCAL_AUTH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** The deprecated NUXT_PUBLIC_KEYCLOAK_* runtime values (defaults ''); a non-empty one wins over /public-config. */
export type KeycloakEnv = { keycloakUrl?: unknown; keycloakRealm?: unknown; keycloakClientId?: unknown }

export type KeycloakOptions = { url: string; realm: string; clientId: string }

/** Why the portal shows the boot screen instead of the app. */
/** `insecure_origin`: keycloak-js needs Web Crypto (PKCE), which a browser gives only to https pages and localhost. */
export type BootError = 'config_unavailable' | 'not_configured' | 'insecure_origin'

export type BootPlan =
  /** /setup or /recovery: no Keycloak at all. */
  | { kind: 'local' }
  /** Setup is not done: the route middleware sends every other page to /setup. */
  | { kind: 'setup' }
  /** Forced recovery mode (`yoda-admin recovery on`): every page goes to /recovery. */
  | { kind: 'recovery' }
  | { kind: 'keycloak'; options: KeycloakOptions }
  /** Setup is done but there is nothing to sign in with (an issuer that is not a Keycloak realm, no overrides). */
  | { kind: 'error'; error: BootError }

/** A non-empty runtime (env) string, else the /public-config value, else ''. */
export function preferEnv(env: unknown, pub: string | null | undefined): string {
  return typeof env === 'string' && env !== '' ? env : (pub ?? '')
}

export function keycloakOptions(env: KeycloakEnv, pub: PublicConfig | null): KeycloakOptions | null {
  const url = preferEnv(env.keycloakUrl, pub?.oidc?.url)
  const realm = preferEnv(env.keycloakRealm, pub?.oidc?.realm)
  const clientId = preferEnv(env.keycloakClientId, pub?.oidc?.clientId)
  return url && realm && clientId ? { url, realm, clientId } : null
}

/**
 * What the boot plugin does for this path, given the config (null: /public-config could not be read). `secure`: the
 * page may use Web Crypto (`isSecureContext`); keycloak-js cannot sign in without it (plain http on a LAN address).
 */
export function bootPlan(path: string, pub: PublicConfig | null, env: KeycloakEnv, secure = true): BootPlan {
  if (isLocalAuthPath(path)) return { kind: 'local' }
  if (!pub) return { kind: 'error', error: 'config_unavailable' }
  if (pub.setup === 'required') return { kind: 'setup' }
  if (pub.recoveryForced) return { kind: 'recovery' }
  const options = keycloakOptions(env, pub)
  if (!options) return { kind: 'error', error: 'not_configured' }
  return secure ? { kind: 'keycloak', options } : { kind: 'error', error: 'insecure_origin' }
}

/** Where the route middleware sends a navigation before anything else runs; null = carry on. */
export function bootRedirect(path: string, pub: PublicConfig | null, bootError: BootError | null): string | null {
  if (isLocalAuthPath(path) || bootError || !pub) return null
  if (pub.setup === 'required') return '/setup'
  return pub.recoveryForced ? '/recovery' : null
}

/** The portal values read once by the shell and pages; a non-empty NUXT_PUBLIC_* value still wins. */
export function publicValues(env: { orgLine?: unknown; runnerDocsUrl?: unknown; lineAddFriendUrl?: unknown }, pub: PublicConfig | null) {
  return {
    orgLine: preferEnv(env.orgLine, pub?.org.line),
    runnerDocsUrl: preferEnv(env.runnerDocsUrl, pub?.runnerDocsUrl),
    lineAddFriendUrl: preferEnv(env.lineAddFriendUrl, pub?.line.addFriendUrl),
  }
}

/**
 * Reads /public-config, trying `attempts` times `delayMs` apart (core restarting during a deploy), then throws the
 * last error. The fetcher must bypass the HTTP cache (`cache: 'no-store'`), so a just-finished setup shows at once.
 */
export async function loadPublicConfig(
  fetcher: () => Promise<PublicConfig>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PublicConfig> {
  const attempts = opts.attempts ?? 3
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetcher()
    } catch (e) {
      last = e
      if (i < attempts - 1) await sleep(opts.delayMs ?? 1000)
    }
  }
  throw last
}
