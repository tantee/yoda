import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { checkDist } from '../scripts/check-dist'
import { buildManifest } from '../src/manifest'

const VERSION = '1.2.0'
type Files = Record<string, string>

/** A minimal release output: the real release manifest and harmless bundles. */
function clean(): Files {
  return {
    'manifest.json': JSON.stringify(buildManifest({ yodaVersion: VERSION, publicKey: null, target: 'release' })),
    'sw.js': 'const a=1;export{a};',
    'injected/main.js': '(function(){window.x=1})();',
    'src/popup/index.html': '<!doctype html><script type="module" src="../../assets/popup.js"></script>',
    'assets/popup.js': 'console.log("popup")',
  }
}

function dir(files: Files): string {
  const d = mkdtempSync(join(tmpdir(), 'check-dist-'))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true })
    writeFileSync(join(d, name), body)
  }
  return d
}

const manifestWith = (patch: Record<string, unknown>): Files => {
  const f = clean()
  f['manifest.json'] = JSON.stringify({ ...JSON.parse(f['manifest.json']!), ...patch })
  return f
}

describe('check-dist', () => {
  it('passes a clean release output, as a directory and as a zip', () => {
    expect(checkDist(dir(clean()), VERSION)).toEqual([])
    const d = mkdtempSync(join(tmpdir(), 'check-dist-zip-'))
    const zip = join(d, 'yoda-reporter-1.2.0.zip')
    writeFileSync(zip, zipSync(Object.fromEntries(Object.entries(clean()).map(([k, v]) => [k, strToU8(v)]))))
    expect(checkDist(zip, VERSION)).toEqual([])
  })

  it('refuses a planted host_permissions entry', () => {
    expect(checkDist(dir(manifestWith({ host_permissions: ['https://*/*'] })), VERSION).join('\n')).toMatch(/host_permissions/)
  })

  it('refuses forbidden or unknown permissions, and a loosened CSP', () => {
    expect(checkDist(dir(manifestWith({ permissions: ['activeTab', 'tabs'] })), VERSION).join('\n')).toMatch(/tabs/)
    expect(checkDist(dir(manifestWith({ optional_host_permissions: ['*://*/*'] })), VERSION).join('\n')).toMatch(/optional_host_permissions/)
    expect(checkDist(dir(manifestWith({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } })), VERSION).join('\n')).toMatch(/content_security_policy/)
    expect(checkDist(dir(manifestWith({ manifest_version: 2 })), VERSION).join('\n')).toMatch(/manifest_version/)
  })

  it('refuses <all_urls> anywhere in a bundle', () => {
    expect(checkDist(dir({ ...clean(), 'assets/popup.js': 'const p=["<all_urls>"]' }), VERSION).join('\n')).toMatch(/<all_urls>.*assets\/popup\.js/)
  })

  it('refuses the e2e tab-target marker', () => {
    expect(checkDist(dir({ ...clean(), 'assets/popup.js': 'console.debug("yoda-e2e-tab-target")' }), VERSION).join('\n')).toMatch(/E2E_TAB_TARGET/)
  })

  it('refuses eval, new Function and remote scripts', () => {
    expect(checkDist(dir({ ...clean(), 'sw.js': 'eval("1")' }), VERSION).join('\n')).toMatch(/eval/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'new Function("return 1")' }), VERSION).join('\n')).toMatch(/new Function/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'importScripts("https://cdn.example.org/x.js")' }), VERSION).join('\n')).toMatch(/remote/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'import("https://cdn.example.org/x.js")' }), VERSION).join('\n')).toMatch(/remote/)
    expect(checkDist(dir({ ...clean(), 'src/popup/index.html': '<script src="https://cdn.example.org/x.js"></script>' }), VERSION).join('\n')).toMatch(/remote/)
  })

  it('does not mistake a method named eval or a plain URL string for code loading', () => {
    expect(checkDist(dir({ ...clean(), 'sw.js': 'a.evaluate(1);const help="https://example.org/help"' }), VERSION)).toEqual([])
  })

  it('refuses a planted private key', () => {
    // Built from parts so this test file itself does not look like a key to gitleaks.
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    expect(checkDist(dir({ ...clean(), 'icons/key.txt': `${pem}\nAAAA\n` }), VERSION).join('\n')).toMatch(/private key/)
  })

  it('refuses a version_name that is not the package version', () => {
    expect(checkDist(dir(manifestWith({ version_name: '1.1.0' })), VERSION).join('\n')).toMatch(/version_name/)
  })

  it('refuses a missing manifest', () => {
    const f = clean()
    delete f['manifest.json']
    expect(checkDist(dir(f), VERSION).join('\n')).toMatch(/manifest\.json/)
  })
})
