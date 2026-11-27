import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addressBlocked, internalAddresses, OutboundError, resolveOutbound, safeFetch, type OutboundPolicy } from '../src/settings/outbound.js'

/** A resolver that answers from a table (no real DNS); counts lookups to show DNS is resolved once. */
function table(entries: Record<string, string[]>) {
  const calls: string[] = []
  const lookup: NonNullable<OutboundPolicy['lookup']> = async (host) => {
    calls.push(host)
    const addrs = entries[host]
    if (!addrs) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { lookup, calls }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (err) {
    if (err instanceof OutboundError) return err.code
    throw err
  }
}

describe('addressBlocked', () => {
  it.each([
    ['169.254.169.254', 'metadata'],
    ['169.254.10.1', 'link-local'],
    ['100.100.100.200', 'metadata'],
    ['168.63.129.16', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback'],
    ['::1', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    // IPv4 hidden in IPv6 forms is checked as IPv4.
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:a9fe:a9fe::1', 'metadata'],
    // IPv4-translated, Teredo, site-local and local-use NAT64: blocked outright.
    ['::ffff:0:10.0.0.5', 'reserved'],
    ['::ffff:0:a9fe:a9fe', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['fec0::1', 'reserved'],
    ['64:ff9b:1::a00:5', 'reserved'],
  ])('%s is blocked (%s)', (ip, why) => {
    expect(addressBlocked(ip, {})).toBe(why)
  })

  it.each(['10.0.0.5', '10.255.1.1', '172.16.0.1', '172.31.255.254', '192.168.1.10', 'fc00::1', 'fd12:3456::1', '8.8.8.8', '2606:4700::1111', '100.64.0.1'])(
    '%s is allowed (private hospital hosts and public)',
    (ip) => {
      expect(addressBlocked(ip, {})).toBeNull()
    },
  )

  it('loopback is allowed only when the policy says so (dev); metadata never is', () => {
    expect(addressBlocked('127.0.0.1', { allowLoopback: true })).toBeNull()
    expect(addressBlocked('::1', { allowLoopback: true })).toBeNull()
    expect(addressBlocked('169.254.169.254', { allowLoopback: true })).toBe('metadata')
  })
})

describe('resolveOutbound', () => {
  it('blocks metadata host names and compose service names before any lookup', async () => {
    const t = table({})
    for (const host of ['metadata.google.internal', 'METADATA.GOOGLE.INTERNAL.', 'metadata', 'postgres', 'rustfs', 'core', 'portal', 'backup', 'migrate', 'runner', 'localhost', 'app.localhost']) {
      expect(await code(resolveOutbound(host, { lookup: t.lookup }))).toBe('blocked_host')
    }
    expect(t.calls).toEqual([])
  })

  it('checks every resolved address: one bad answer blocks the host', async () => {
    const t = table({ 'mixed.example.org': ['10.0.0.8', '169.254.169.254'], 'ok.example.org': ['10.0.0.8', '192.168.0.9'] })
    expect(await code(resolveOutbound('mixed.example.org', { lookup: t.lookup }))).toBe('blocked_address')
    expect(await resolveOutbound('ok.example.org', { lookup: t.lookup })).toEqual({
      address: '10.0.0.8',
      family: 4,
      private: true,
      addresses: [{ address: '10.0.0.8', family: 4 }, { address: '192.168.0.9', family: 4 }],
    })
  })

  it('reads decimal, octal and hex IPv4 spellings as the address they stand for, without a lookup', async () => {
    const t = table({})
    for (const host of ['2852039166', '0251.0376.0251.0376', '0xa9fea9fe', '0xA9.0xFE.0xA9.0xFE', '169.254.43518', '017700000001']) {
      expect(await code(resolveOutbound(host, t)), host).toBe('blocked_address')
    }
    expect(await resolveOutbound('0x0a000001', t)).toMatchObject({ address: '10.0.0.1' })
    expect(t.calls).toEqual([])
  })

  it('blocks the addresses in blockedAddresses (core itself, the compose services)', async () => {
    const t = table({ 'db.example.org': ['10.0.0.8'] })
    const blockedAddresses = new Set(['10.0.0.8'])
    expect(await code(resolveOutbound('db.example.org', { lookup: t.lookup, blockedAddresses }))).toBe('blocked_address')
    expect(await code(resolveOutbound('10.0.0.8', { blockedAddresses }))).toBe('blocked_address')
    expect(addressBlocked('10.0.0.8', { blockedAddresses })).toBe('internal')
  })

  it('counts a slow lookup against the timeout', async () => {
    const lookup = () => new Promise<{ address: string; family: number }[]>(() => {})
    expect(await code(resolveOutbound('slow.example.org', { lookup }, 50))).toBe('timeout')
    const started = Date.now()
    expect(await code(safeFetch('https://slow.example.org/', { policy: { lookup }, timeoutMs: 100 }))).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('maps a failed lookup to dns_failed', async () => {
    expect(await code(resolveOutbound('nowhere.example.org', table({})))).toBe('dns_failed')
  })

  it('checks IP literals without a lookup', async () => {
    const t = table({})
    expect(await code(resolveOutbound('169.254.169.254', t))).toBe('blocked_address')
    expect(await code(resolveOutbound('[::1]', t))).toBe('blocked_address')
    expect(await resolveOutbound('10.1.2.3', t)).toMatchObject({ address: '10.1.2.3' })
    expect(t.calls).toEqual([])
  })
})

describe('internalAddresses', () => {
  it('collects core\'s own non-internal interface addresses and what the service names resolve to, skipping failures', async () => {
    const lookup = async (h: string) => {
      if (h === 'postgres') return [{ address: '172.18.0.2' }]
      if (h === 'rustfs') return [{ address: 'FD00::3' }]
      throw new Error('ENOTFOUND')
    }
    const interfaces = () => ({ lo0: [{ address: '127.0.0.1', internal: true }], eth0: [{ address: '172.18.0.5', internal: false }] })
    expect([...(await internalAddresses(lookup, interfaces))].sort()).toEqual(['172.18.0.2', '172.18.0.5', 'fd00::3'])
  })
})

describe('safeFetch', () => {
  let server: Server
  let port: number
  const hits: { url: string; host: string | undefined }[] = []

  beforeEach(async () => {
    hits.length = 0
    server = createServer((req, res) => {
      hits.push({ url: req.url ?? '', host: req.headers.host })
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        return res.end()
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end('x'.repeat(200 * 1024))
      }
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('refuses loopback by default, and fetches it when allowed (dev)', async () => {
    expect(await code(safeFetch(`http://127.0.0.1:${port}/`))).toBe('blocked_address')
    expect(hits).toEqual([])
    const res = await safeFetch(`http://127.0.0.1:${port}/`, { policy: { allowLoopback: true } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('resolves DNS once and connects to that address with the original Host header (no rebinding)', async () => {
    // A rebinding resolver: the first answer is allowed, any later one would be metadata.
    let n = 0
    const lookup: OutboundPolicy['lookup'] = async () => [{ address: n++ === 0 ? '127.0.0.1' : '169.254.169.254', family: 4 }]
    const res = await safeFetch(`http://sso.example.org:${port}/x`, { policy: { allowLoopback: true, lookup } })
    expect(res.status).toBe(200)
    expect(n).toBe(1)
    expect(hits).toEqual([{ url: '/x', host: `sso.example.org:${port}` }])
  })

  it('tries the next checked address when one refuses the connection (localhost → ::1, then 127.0.0.1)', async () => {
    // The server listens on 127.0.0.1 only, so ::1 is refused (or unreachable without IPv6).
    const t = table({ 'sso.example.org': ['::1', '127.0.0.1'] })
    const res = await safeFetch(`http://sso.example.org:${port}/x`, { policy: { allowLoopback: true, lookup: t.lookup } })
    expect(res.status).toBe(200)
    expect(t.calls).toEqual(['sso.example.org'])
    expect(hits).toEqual([{ url: '/x', host: `sso.example.org:${port}` }])
    // Every address refused: the usual short code, still one lookup.
    const closed = table({ 'down.example.org': ['::1', '127.0.0.1'] })
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    expect(await code(safeFetch(`http://down.example.org:${port}/`, { policy: { allowLoopback: true, lookup: closed.lookup } }))).toBe('connect_failed')
    expect(closed.calls).toEqual(['down.example.org'])
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  })

  it('does not follow redirects', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/redirect`, { policy: { allowLoopback: true } })
    expect(res.status).toBe(302)
    expect(hits).toHaveLength(1)
  })

  it('caps the response size and times out', async () => {
    const policy = { allowLoopback: true }
    expect(await code(safeFetch(`http://127.0.0.1:${port}/big`, { policy }))).toBe('too_large')
    expect(await code(safeFetch(`http://127.0.0.1:${port}/slow`, { policy, timeoutMs: 200 }))).toBe('timeout')
  })

  it('allows only http and https, and plain http only to private (internal) addresses', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://10.0.0.1/', 'ftp://10.0.0.1/', 'not a url']) {
      expect(await code(safeFetch(url))).toMatch(/^(scheme_not_allowed|invalid_url)$/)
    }
    const t = table({ 'public.example.org': ['93.184.215.14'] })
    expect(await code(safeFetch('http://public.example.org/', { policy: { lookup: t.lookup } }))).toBe('https_required')
  })

  it('maps a refused connection to connect_failed and names no address', async () => {
    const err = await safeFetch('http://127.0.0.1:9/', { policy: { allowLoopback: true } }).catch((e) => e)
    expect(err).toBeInstanceOf(OutboundError)
    expect(err.code).toBe('connect_failed')
    expect(String(err.message)).not.toContain('127.0.0.1')
  })
})
