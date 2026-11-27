import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, createServer, type Server } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tlsProbe } from '../src/proxy-status.js'

// The TLS handshake behind the setup wizard's built-in proxy card, against a local TLS server with a throwaway
// certificate made here (never committed). Skipped without openssl.
const openssl = spawnSync('openssl', ['version']).status === 0

describe.runIf(openssl)('tlsProbe', () => {
  let dir: string
  let server: Server
  let port: number
  let names: string[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'yoda-tls-'))
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=portal.example.org/O=Example Hospital', '-addext', 'subjectAltName=DNS:portal.example.org', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    names = []
    const pair = { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }
    const ctx = createSecureContext(pair)
    // SNI as Caddy picks the certificate: the probe must send the configured name.
    server = createServer({ ...pair, SNICallback: (name, cb) => (names.push(name), cb(null, ctx)) }, (s) => s.end())
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((done) => server.close(done))
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the presented certificate for the name, without trusting its chain', async () => {
    const r = await tlsProbe({ host: '127.0.0.1', port, servername: 'portal.example.org', timeoutMs: 3000 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cert.subject.CN).toBe('portal.example.org')
    expect(r.cert.subjectaltname).toBe('DNS:portal.example.org')
    expect(new Date(r.cert.valid_to).getTime()).toBeGreaterThan(Date.now())
    expect(names).toContain('portal.example.org')
  })

  it('names a refused connection and an unknown host', async () => {
    const closed = createServer()
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done))
    const free = (closed.address() as AddressInfo).port
    await new Promise((done) => closed.close(done))
    expect(await tlsProbe({ host: '127.0.0.1', port: free, servername: 'portal.example.org', timeoutMs: 3000 })).toEqual({ ok: false, error: 'refused' })
    expect(await tlsProbe({ host: 'proxy.invalid', port: 443, servername: 'portal.example.org', timeoutMs: 3000 })).toEqual({ ok: false, error: 'not_found' })
  })
})
