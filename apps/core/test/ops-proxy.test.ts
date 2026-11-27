import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// ops/proxy/Caddyfile through `caddy validate` in the very image docker-compose.prod.yml pins, for each certificate
// mode (docs/operations.md, section 4b). Needs docker and openssl (the throwaway certificates are made here, never
// committed); skipped without them (the GitLab test job), run on GitHub's CI runners and developer machines.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0
const docker = process.platform !== 'win32' && has('docker', ['info', '--format', '{{.ServerVersion}}']) && has('openssl', ['version'])
const prod = parse(readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8'), { logLevel: 'error' }) as { services: { proxy: { image: string } } }
const image = prod.services.proxy.image

describe.runIf(docker)('ops/proxy/Caddyfile validates in the pinned Caddy image', () => {
  let dir: string
  const cert = (name: string, cn: string) => {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${cn}`, '-keyout', join(dir, `${name}-key.pem`), '-out', join(dir, `${name}-cert.pem`)], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'yoda-caddy-'))
    for (const d of ['good', 'mismatch', 'sites']) mkdirSync(join(dir, d))
    cert('a', 'portal.example.org')
    cert('b', 'other.example.org')
    writeFileSync(join(dir, 'good/cert.pem'), readFileSync(join(dir, 'a-cert.pem')))
    writeFileSync(join(dir, 'good/key.pem'), readFileSync(join(dir, 'a-key.pem')))
    writeFileSync(join(dir, 'mismatch/cert.pem'), readFileSync(join(dir, 'a-cert.pem')))
    writeFileSync(join(dir, 'mismatch/key.pem'), readFileSync(join(dir, 'b-key.pem')))
    expect(has('docker', ['image', 'inspect', image]) || has('docker', ['pull', '-q', image]), `cannot pull ${image}`).toBe(true)
  }, 120_000)

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const validate = (env: Record<string, string>, certs = 'good') => {
    const args = ['run', '--rm', '--network', 'none', '-v', `${join(root, 'ops/proxy/Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${join(dir, certs)}:/etc/caddy/certs:ro`, '-v', `${join(dir, 'sites')}:/etc/caddy/sites:ro`]
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push(image, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
    const r = spawnSync('docker', args, { encoding: 'utf8' })
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }
  }
  const D = { YODA_PROXY_DOMAIN: 'portal.example.org' }

  it.each([
    ['internal', { YODA_PROXY_CERT_MODE: 'internal' }],
    ['files', { YODA_PROXY_CERT_MODE: 'files' }],
    ['acme', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org' }],
    ['internal on other ports', { YODA_PROXY_CERT_MODE: 'internal', YODA_PROXY_HTTP_PORT: '8080', YODA_PROXY_HTTPS_PORT: '8443' }],
  ])('accepts %s', (_name, env) => {
    const r = validate({ ...D, ...env })
    expect(r.out).toContain('Valid configuration')
    expect(r.ok, r.out).toBe(true)
  }, 60_000)

  it.each([
    ['no domain', { YODA_PROXY_CERT_MODE: 'internal' }, 'good', /server block without any key/],
    ['an unknown mode', { ...D, YODA_PROXY_CERT_MODE: 'self' }, 'good', /File to import not found: tls-self/],
    ['acme without an email', { ...D, YODA_PROXY_CERT_MODE: 'acme' }, 'good', /wrong argument count/],
    ['files without the files', { ...D, YODA_PROXY_CERT_MODE: 'files' }, 'sites', /no such file or directory/],
    ['files whose key is not the certificate\'s', { ...D, YODA_PROXY_CERT_MODE: 'files' }, 'mismatch', /private key does not match public key/],
  ])('refuses %s', (_name, env, certs, message) => {
    const r = validate(env, certs)
    expect(r.ok, r.out).toBe(false)
    expect(r.out).toMatch(message)
  }, 60_000)
})
