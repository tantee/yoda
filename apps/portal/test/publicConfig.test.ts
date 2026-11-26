import type { PublicConfig } from '@yoda/shared'
import { describe, expect, it, vi } from 'vitest'
import { bootPlan, bootRedirect, isLocalAuthPath, keycloakOptions, loadPublicConfig, publicValues } from '~/utils/publicConfig'

const pub = (over: Partial<PublicConfig> = {}): PublicConfig => ({
  oidc: { url: 'https://sso.example.org', realm: 'hospital', clientId: 'yoda-portal' },
  org: { name: 'Example hospital', nameEn: null, line: 'IT department', defaultLocale: 'th' },
  runnerDocsUrl: 'https://github.com/tantee/yoda#runners',
  line: { addFriendUrl: 'https://line.example.org/add' },
  funMode: true,
  setup: 'done',
  recovery: false,
  recoveryForced: false,
  version: '1.0.0',
  ...over,
})
const noEnv = { keycloakUrl: '', keycloakRealm: '', keycloakClientId: '' }

describe('portal boot with /public-config', () => {
  it('never starts Keycloak on /setup or /recovery, whatever the config', () => {
    for (const path of ['/setup', '/setup/step-2', '/recovery', '/recovery/'])
      for (const p of [pub(), pub({ setup: 'required', oidc: null }), null]) expect(bootPlan(path, p, noEnv), path).toEqual({ kind: 'local' })
    expect(isLocalAuthPath('/setupx')).toBe(false)
    expect(isLocalAuthPath('/settings')).toBe(false)
  })

  it('signs in with the config derived from the issuer when no override is set', () => {
    expect(bootPlan('/', pub(), noEnv)).toEqual({ kind: 'keycloak', options: { url: 'https://sso.example.org', realm: 'hospital', clientId: 'yoda-portal' } })
  })

  it('still honours a non-empty NUXT_PUBLIC_KEYCLOAK_* value (deprecated override)', () => {
    expect(keycloakOptions({ keycloakUrl: 'http://localhost:8080', keycloakRealm: 'yoda', keycloakClientId: '' }, pub())).toEqual({ url: 'http://localhost:8080', realm: 'yoda', clientId: 'yoda-portal' })
    // A full set of overrides works even if the issuer is not a Keycloak realm.
    expect(bootPlan('/', pub({ oidc: null }), { keycloakUrl: 'http://localhost:8080', keycloakRealm: 'yoda', keycloakClientId: 'yoda-portal' }).kind).toBe('keycloak')
  })

  it('sends every other page to /setup while setup is required', () => {
    expect(bootPlan('/', pub({ setup: 'required', oidc: null }), noEnv)).toEqual({ kind: 'setup' })
    expect(bootRedirect('/requests', pub({ setup: 'required' }), null)).toBe('/setup')
    expect(bootRedirect('/setup', pub({ setup: 'required' }), null)).toBeNull()
    expect(bootRedirect('/requests', pub(), null)).toBeNull()
    expect(bootRedirect('/requests', null, 'config_unavailable')).toBeNull()
  })

  it('sends every page to /recovery in forced recovery mode, without Keycloak; a key problem alone does not', () => {
    const forced = pub({ recovery: true, recoveryForced: true })
    expect(bootPlan('/', forced, noEnv)).toEqual({ kind: 'recovery' })
    expect(bootRedirect('/admin/settings', forced, null)).toBe('/recovery')
    expect(bootRedirect('/recovery', forced, null)).toBeNull()
    expect(bootPlan('/', pub({ recovery: true }), noEnv).kind).toBe('keycloak')
    expect(bootRedirect('/requests', pub({ recovery: true }), null)).toBeNull()
  })

  it('shows the retry screen when the config cannot be read, and the not-configured screen without sign-in', () => {
    expect(bootPlan('/', null, noEnv)).toEqual({ kind: 'error', error: 'config_unavailable' })
    expect(bootPlan('/', pub({ oidc: null }), noEnv)).toEqual({ kind: 'error', error: 'not_configured' })
  })

  it('retries the fetch, then gives up with the last error', async () => {
    const sleep = vi.fn(async () => {})
    let n = 0
    const ok = await loadPublicConfig(async () => {
      if (++n < 3) throw new Error(`down ${n}`)
      return pub()
    }, { attempts: 3, delayMs: 5, sleep })
    expect(ok.setup).toBe('done')
    expect(sleep).toHaveBeenCalledTimes(2)
    await expect(loadPublicConfig(async () => { throw new Error('still down') }, { attempts: 2, sleep })).rejects.toThrow('still down')
  })

  it('reads the shell values from the config, a non-empty env value first', () => {
    expect(publicValues({ orgLine: '', runnerDocsUrl: '', lineAddFriendUrl: '' }, pub())).toEqual({
      orgLine: 'IT department',
      runnerDocsUrl: 'https://github.com/tantee/yoda#runners',
      lineAddFriendUrl: 'https://line.example.org/add',
    })
    expect(publicValues({ orgLine: 'From env' }, pub()).orgLine).toBe('From env')
    expect(publicValues({}, null)).toEqual({ orgLine: '', runnerDocsUrl: '', lineAddFriendUrl: '' })
  })
})
