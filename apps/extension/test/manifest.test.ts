import { readFileSync } from 'node:fs'
import { manifestVersion } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { buildManifest, FORBIDDEN_MANIFEST_KEYS, FORBIDDEN_PERMISSIONS, OPTIONAL_HOST_PERMISSIONS, OPTIONAL_PERMISSIONS, REQUIRED_PERMISSIONS } from '../src/manifest'
import vitestConfig from '../vitest.config'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const rootPkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
const corePkg = JSON.parse(readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8')) as { version: string }
const SPKI = 'not-a-real-public-key'

describe('buildManifest', () => {
  const release = buildManifest({ yodaVersion: '1.2.0', publicKey: null, target: 'release' }) as Record<string, unknown>

  it('release manifest has exactly the required and optional permissions of §5 and none of the forbidden keys (including alarms and tabs)', () => {
    expect(release.manifest_version).toBe(3)
    expect(release.minimum_chrome_version).toBe('116')
    expect(release.permissions).toEqual([...REQUIRED_PERMISSIONS])
    expect(REQUIRED_PERMISSIONS).toEqual(['activeTab', 'scripting', 'storage', 'identity', 'offscreen'])
    expect(release.optional_permissions).toEqual([...OPTIONAL_PERMISSIONS])
    expect(OPTIONAL_PERMISSIONS).toEqual(['tabCapture'])
    expect(release.optional_host_permissions).toEqual([...OPTIONAL_HOST_PERMISSIONS])
    expect(release).not.toHaveProperty('host_permissions')
    for (const k of FORBIDDEN_MANIFEST_KEYS) expect(release).not.toHaveProperty(k)
    expect(FORBIDDEN_MANIFEST_KEYS).toEqual(expect.arrayContaining(['content_scripts', 'web_accessible_resources', 'externally_connectable']))
    const all = JSON.stringify(release)
    for (const p of FORBIDDEN_PERMISSIONS) expect((release.permissions as string[]).includes(p) || (release.optional_permissions as string[]).includes(p)).toBe(false)
    expect(FORBIDDEN_PERMISSIONS).toEqual(expect.arrayContaining(['tabs', 'alarms', 'debugger', 'webRequest', 'cookies', '<all_urls>']))
    expect(all).not.toContain('<all_urls>')
    expect(release.commands).toEqual({ _execute_action: { suggested_key: { default: 'Alt+Shift+Y' } } })
    expect(release.background).toEqual({ service_worker: 'sw.js', type: 'module' })
    expect(release).not.toHaveProperty('storage')
  })

  it('e2e manifest differs only by host_permissions', () => {
    const e2e = buildManifest({ yodaVersion: '1.2.0', publicKey: null, target: 'e2e' }) as Record<string, unknown>
    const { host_permissions, ...rest } = e2e
    expect(host_permissions).toEqual(['<all_urls>'])
    expect(rest).toEqual(release)
  })

  it('version follows manifestVersion and package.json equals the root version', () => {
    expect(release.version).toBe('1.2.0.1000')
    expect(release.version_name).toBe('1.2.0')
    const rc = buildManifest({ yodaVersion: '1.3.0-rc.2', publicKey: null, target: 'release' })
    expect([rc.version, rc.version_name]).toEqual(['1.3.0.2', '1.3.0-rc.2'])
    expect(pkg.version).toBe(rootPkg.version)
    expect(pkg.version).toBe(corePkg.version)
    expect(manifestVersion(pkg.version).versionName).toBe(pkg.version)
  })

  it('key is present only with a public key', () => {
    expect(release).not.toHaveProperty('key')
    expect(buildManifest({ yodaVersion: '1.2.0', publicKey: SPKI, target: 'release' }).key).toBe(SPKI)
  })

  it('names Yoda Reporter in both languages through _locales', () => {
    expect(release.name).toBe('__MSG_extName__')
    expect(release.default_locale).toBe('th')
  })
})

describe('the vitest config', () => {
  it('includes only test/**/*.test.ts', () => {
    expect((vitestConfig as { test: { include: string[] } }).test.include).toEqual(['test/**/*.test.ts'])
  })
})
