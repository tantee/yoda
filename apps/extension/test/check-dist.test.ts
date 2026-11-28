import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { checkDist } from '../scripts/check-dist'
import { buildManifest } from '../src/manifest'

const VERSION = '1.2.0'
// The committed public key (keys/yoda-reporter.pub) and the ID it gives.
const KEY = readFileSync(new URL('../../../keys/yoda-reporter.pub', import.meta.url), 'utf8').trim()
const ID = 'hcnhkfonaflhcknbhcphbfgpdfmgmibm'
type Files = Record<string, string>

/** A minimal release output: the real release manifest and harmless bundles. */
function clean(): Files {
  return {
    'manifest.json': JSON.stringify(buildManifest({ yodaVersion: VERSION, publicKey: KEY, target: 'release' })),
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
    expect(checkDist(dir(clean()), VERSION, ID)).toEqual([])
    const d = mkdtempSync(join(tmpdir(), 'check-dist-zip-'))
    const zip = join(d, 'yoda-reporter-1.2.0.zip')
    writeFileSync(zip, zipSync(Object.fromEntries(Object.entries(clean()).map(([k, v]) => [k, strToU8(v)]))))
    expect(checkDist(zip, VERSION, ID)).toEqual([])
  })

  it('refuses a planted host_permissions entry', () => {
    expect(checkDist(dir(manifestWith({ host_permissions: ['https://*/*'] })), VERSION, ID).join('\n')).toMatch(/host_permissions/)
  })

  it('refuses forbidden or unknown permissions, and a loosened CSP', () => {
    expect(checkDist(dir(manifestWith({ permissions: ['activeTab', 'tabs'] })), VERSION, ID).join('\n')).toMatch(/tabs/)
    expect(checkDist(dir(manifestWith({ optional_host_permissions: ['*://*/*'] })), VERSION, ID).join('\n')).toMatch(/optional_host_permissions/)
    expect(checkDist(dir(manifestWith({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } })), VERSION, ID).join('\n')).toMatch(/content_security_policy/)
    expect(checkDist(dir(manifestWith({ manifest_version: 2 })), VERSION, ID).join('\n')).toMatch(/manifest_version/)
  })

  it('refuses <all_urls> anywhere in a bundle', () => {
    expect(checkDist(dir({ ...clean(), 'assets/popup.js': 'const p=["<all_urls>"]' }), VERSION, ID).join('\n')).toMatch(/<all_urls>.*assets\/popup\.js/)
  })

  it('refuses the e2e tab-target marker', () => {
    expect(checkDist(dir({ ...clean(), 'assets/popup.js': 'console.debug("yoda-e2e-tab-target")' }), VERSION, ID).join('\n')).toMatch(/E2E_TAB_TARGET/)
  })

  it('refuses eval, new Function and remote scripts', () => {
    expect(checkDist(dir({ ...clean(), 'sw.js': 'eval("1")' }), VERSION, ID).join('\n')).toMatch(/eval/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'new Function("return 1")' }), VERSION, ID).join('\n')).toMatch(/new Function/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'importScripts("https://cdn.example.org/x.js")' }), VERSION, ID).join('\n')).toMatch(/remote/)
    expect(checkDist(dir({ ...clean(), 'sw.js': 'import("https://cdn.example.org/x.js")' }), VERSION, ID).join('\n')).toMatch(/remote/)
    expect(checkDist(dir({ ...clean(), 'src/popup/index.html': '<script src="https://cdn.example.org/x.js"></script>' }), VERSION, ID).join('\n')).toMatch(/remote/)
  })

  it('does not mistake a method named eval or a plain URL string for code loading', () => {
    expect(checkDist(dir({ ...clean(), 'sw.js': 'a.evaluate(1);const help="https://example.org/help"' }), VERSION, ID)).toEqual([])
  })

  it('refuses a planted private key', () => {
    // Built from parts so this test file itself does not look like a key to gitleaks.
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    expect(checkDist(dir({ ...clean(), 'icons/key.txt': `${pem}\nAAAA\n` }), VERSION, ID).join('\n')).toMatch(/private key/)
  })

  it('refuses a version_name that is not the package version', () => {
    expect(checkDist(dir(manifestWith({ version_name: '1.1.0' })), VERSION, ID).join('\n')).toMatch(/version_name/)
  })

  it('refuses a manifest without the key, or with a key for another ID, while there is an official ID', () => {
    expect(checkDist(dir(manifestWith({ key: undefined })), VERSION, ID).join('\n')).toMatch(/no key/)
    expect(checkDist(dir(manifestWith({ key: Buffer.from('not-a-real-public-key').toString('base64') })), VERSION, ID).join('\n')).toMatch(/not the official/)
    // Before the owner's key existed (no official ID), a keyless build was allowed.
    expect(checkDist(dir(manifestWith({ key: undefined })), VERSION, null)).toEqual([])
  })

  it('refuses the indirect eval forms and string timers too', () => {
    for (const code of ['(0,eval)("1")', 'window.eval("1")', 'self["eval"]("1")', 'Function("return 1")()', 'setTimeout("alert(1)", 1)'])
      expect(checkDist(dir({ ...clean(), 'injected/main.js': code }), VERSION, ID), code).not.toEqual([])
  })

  it('refuses a missing manifest', () => {
    const f = clean()
    delete f['manifest.json']
    expect(checkDist(dir(f), VERSION, ID).join('\n')).toMatch(/manifest\.json/)
  })
})
