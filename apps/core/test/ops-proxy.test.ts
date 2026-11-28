import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { interpolate } from './prod-compose-env.js'

// ops/proxy/Caddyfile through `caddy validate` in the very image docker-compose.prod.yml pins, for each certificate
// mode (docs/operations.md, section 4b). Needs docker and openssl (the throwaway certificates are made here, never
// committed); skipped without them (the GitLab test job), run on GitHub's CI runners and developer machines.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0
const docker = process.platform !== 'win32' && has('docker', ['info', '--format', '{{.ServerVersion}}']) && has('openssl', ['version'])
const prod = parse(readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8'), { logLevel: 'error' }) as { services: { proxy: { image: string; command: string[]; environment: Record<string, string> } } }
const image = prod.services.proxy.image
const proxy = prod.services.proxy

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

  // `env` is the host's .env: the container gets what compose makes of it (its defaults, and the empty values it
  // passes, which Caddy's {$NAME:default} does not replace), with ops/proxy mounted as the service mounts it.
  const validate = (env: Record<string, string>, certs = 'good') => {
    const args = ['run', '--rm', '--network', 'none', '-v', `${join(root, 'ops/proxy')}:/etc/caddy/yoda:ro`, '-v', `${join(dir, certs)}:/etc/caddy/certs:ro`, '-v', `${join(dir, 'sites')}:/etc/caddy/sites:ro`]
    for (const [k, v] of Object.entries(proxy.environment)) args.push('-e', `${k}=${interpolate(String(v), env)}`)
    const config = proxy.command[proxy.command.indexOf('--config') + 1]!
    args.push(image, 'caddy', 'validate', '--config', config, '--adapter', 'caddyfile')
    const r = spawnSync('docker', args, { encoding: 'utf8' })
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` }
  }
  const D = { YODA_PROXY_DOMAIN: 'portal.example.org' }

  it.each([
    ['internal', { YODA_PROXY_CERT_MODE: 'internal' }],
    ['files', { YODA_PROXY_CERT_MODE: 'files' }],
    ['acme', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org' }],
    // .env.example ships the line empty: compose then passes Let's Encrypt's directory.
    ['acme with an empty YODA_PROXY_ACME_CA', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org', YODA_PROXY_ACME_CA: '' }],
    ['acme on Let\'s Encrypt staging', { YODA_PROXY_CERT_MODE: 'acme', YODA_PROXY_ACME_EMAIL: 'it@example.org', YODA_PROXY_ACME_CA: 'https://acme-staging-v02.api.letsencrypt.org/directory' }],
    ['an empty mode (compose: internal)', { YODA_PROXY_CERT_MODE: '' }],
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

// The body caps on a running proxy (plan A13, Review Focus 2): the pinned Caddy image with the bundle's
// Caddyfile (internal certificates), in front of a second Caddy aliased `portal` that answers 200.
describe.runIf(docker && has('curl', ['--version']))('the running proxy caps request bodies by path', () => {
  const tag = `yoda-caps-${process.pid}-${Date.now()}`
  let dir: string
  let port = ''
  const run = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' })
  const post = (path: string, file: string) => {
    const r = spawnSync('curl', ['-sk', '--max-time', '120', '--resolve', `portal.example.org:${port}:127.0.0.1`, '-o', '/dev/null', '-w', '%{http_code}', '-H', 'content-type: application/octet-stream', '--data-binary', `@${file}`, `https://portal.example.org:${port}${path}`], { encoding: 'utf8' })
    return r.stdout.trim()
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yoda-caps-'))
    for (const d of ['certs', 'sites']) mkdirSync(join(dir, d))
    for (const [name, mib] of [['40', 40], ['60', 60]] as const) writeFileSync(join(dir, `${name}.bin`), Buffer.alloc(mib * 1024 * 1024, 120))
    expect(has('docker', ['image', 'inspect', image]) || has('docker', ['pull', '-q', image]), `cannot pull ${image}`).toBe(true)
    expect(run(['network', 'create', tag]).status).toBe(0)
    // The stand-in portal reads the whole body (as the real one does): the proxy's cap trips only while it is read.
    writeFileSync(join(dir, 'Portalfile'), ':3000 {\n\trespond "{http.request.body}" 200\n}\n')
    const portal = run(['run', '-d', '--rm', '--name', `${tag}-portal`, '--network', tag, '--network-alias', 'portal', '-v', `${join(dir, 'Portalfile')}:/etc/caddy/Portalfile:ro`, image, 'caddy', 'run', '--config', '/etc/caddy/Portalfile', '--adapter', 'caddyfile'])
    expect(portal.status, portal.stderr).toBe(0)
    const env = { YODA_PROXY_DOMAIN: 'portal.example.org', YODA_PROXY_CERT_MODE: 'internal', YODA_PROXY_HTTP_PORT: '80', YODA_PROXY_HTTPS_PORT: '443' }
    const args = ['run', '-d', '--rm', '--name', `${tag}-proxy`, '--network', tag, '-p', '127.0.0.1::443', '-v', `${join(root, 'ops/proxy')}:/etc/caddy/yoda:ro`, '-v', `${join(dir, 'certs')}:/etc/caddy/certs:ro`, '-v', `${join(dir, 'sites')}:/etc/caddy/sites:ro`]
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push(image, ...proxy.command)
    const p = run(args)
    expect(p.status, p.stderr).toBe(0)
    port = run(['port', `${tag}-proxy`, '443/tcp']).stdout.trim().split(':').pop() ?? ''
    expect(port).toMatch(/^\d+$/)
    // Ready once a small request gets through (the internal certificate is issued on start).
    for (let i = 0; i < 60; i++) {
      const r = spawnSync('curl', ['-sk', '--max-time', '5', '--resolve', `portal.example.org:${port}:127.0.0.1`, '-o', '/dev/null', '-w', '%{http_code}', `https://portal.example.org:${port}/api/health`], { encoding: 'utf8' })
      if (r.stdout.trim() === '200') return
      await new Promise((res) => setTimeout(res, 1000))
    }
    throw new Error(`proxy not ready: ${run(['logs', `${tag}-proxy`]).stderr.slice(-2000)}`)
  }, 180_000)

  afterAll(() => {
    run(['rm', '-f', `${tag}-proxy`, `${tag}-portal`])
    run(['network', 'rm', tag])
    rmSync(dir, { recursive: true, force: true })
  })

  it('a 40 MiB POST to /api/extension/defects passes the proxy (200)', () => {
    expect(post('/api/extension/defects', join(dir, '40.bin'))).toBe('200')
  }, 150_000)

  it('a 40 MiB POST to /api/projects/x/attachments gets 413', () => {
    expect(post('/api/projects/x/attachments', join(dir, '40.bin'))).toBe('413')
  }, 150_000)

  it('a 60 MiB POST to the defects path gets 413', () => {
    expect(post('/api/extension/defects', join(dir, '60.bin'))).toBe('413')
  }, 150_000)
})
