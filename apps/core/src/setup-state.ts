import type { Config } from './config.js'
import type { SettingsStore } from './settings/store.js'

/**
 * Setup is done once the wizard finished (or an env install was marked done on upgrade, §6.5), when the OIDC
 * issuer comes from env (an env-based install, even with no data yet), or in dev with YODA_DEV_SKIP_SETUP=true.
 * Without a settings store (tests), a configured issuer counts as done. `/public-config` (the portal) and the
 * setup-mode gate in the auth hook both use this, so they always agree.
 */
export function setupState(
  config: Pick<Config, 'oidcIssuer' | 'devSkipSetup'>,
  settings: Pick<SettingsStore, 'setupDone' | 'fromEnv'> | undefined,
): 'required' | 'done' {
  if (config.devSkipSetup) return 'done'
  if (!settings) return config.oidcIssuer ? 'done' : 'required'
  return settings.setupDone || settings.fromEnv('oidc.issuer') ? 'done' : 'required'
}
