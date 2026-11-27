import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

/**
 * `safeOutbound` (installer proposal §8.5): every settings test connects through here, because the address is
 * one an admin typed (an SSRF vector).
 *
 * - Schemes: http and https only (SMTP resolves through `resolveOutbound` and connects to the address it gives).
 *   Plain http only to private (internal) addresses; a public host needs https.
 * - DNS is resolved once, every answer is checked, and the connection goes to that address (no DNS rebinding).
 *   TLS still checks the certificate against the host name (SNI), and the Host header is the original one.
 * - Allowed: public addresses and the private ranges hospitals run Keycloak, GitLab, SMTP and LLM gateways on
 *   (10/8, 172.16/12, 192.168/16, fc00::/7).
 * - Blocked: cloud metadata, link-local, unspecified, multicast, reserved, loopback (unless the policy allows it:
 *   dev only), and the compose service names. Service names are blocked by name only: the compose network's
 *   addresses are private and so cannot be told apart from a hospital host.
 * - No redirects are followed (the 3xx is returned), 5 s to connect, 10 s in all, 64 KB of response at most.
 * - Errors are short codes and never carry an address, a URL or a server's text.
 */

export type OutboundCode =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'https_required'
  | 'blocked_host'
  | 'blocked_address'
  | 'blocked_port'
  | 'dns_failed'
  | 'connect_failed'
  | 'timeout'
  | 'tls_failed'
  | 'too_large'

export class OutboundError extends Error {
  constructor(readonly code: OutboundCode) {
    super(`outbound request refused or failed: ${code}`)
    this.name = 'OutboundError'
  }
}

export type BlockReason = 'metadata' | 'link-local' | 'loopback' | 'unspecified' | 'multicast' | 'reserved'

export type OutboundPolicy = {
  /** Loopback targets (the dev fakes on 127.0.0.1): only with YODA_OUTBOUND_ALLOW_LOOPBACK=true (dev, tests). */
  allowLoopback?: boolean
  /**
   * Further addresses never connected to: core's own interfaces and what the compose service names resolved to
   * at boot (`internalAddresses`). Best effort: a container that restarts later may get another address.
   */
  blockedAddresses?: ReadonlySet<string>
  /** Replaces the DNS lookup (tests). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>
}

/** Cloud metadata names, and the compose service names core must never be pointed at. */
const BLOCKED_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'postgres',
  'rustfs',
  'core',
  'portal',
  'backup',
  'migrate',
  'runner',
])

function v4Octets(ip: string): number[] {
  return ip.split('.').map(Number)
}

function v4Blocked(ip: string, policy: OutboundPolicy): BlockReason | null {
  const [a, b, c, d] = v4Octets(ip) as [number, number, number, number]
  if (a === 0) return 'unspecified'
  if (a === 127) return policy.allowLoopback ? null : 'loopback'
  // AWS/GCP/Azure (169.254.169.254), Alibaba (100.100.100.200), Azure wire server (168.63.129.16).
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata'
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'metadata'
  if (a === 168 && b === 63 && c === 129 && d === 16) return 'metadata'
  if (a === 169 && b === 254) return 'link-local'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  return null
}

/** Eight 16-bit groups, or null when not IPv6. Handles `::` and a trailing dotted IPv4. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const lastColon = s.lastIndexOf(':')
  const last = s.slice(lastColon + 1)
  if (last.includes('.')) {
    // A trailing dotted IPv4 becomes its two hex groups.
    if (!isIPv4(last)) return null
    const [a, b, c, d] = v4Octets(last) as [number, number, number, number]
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part ? part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : [])
  const head = parse(halves[0]!)
  const rest = halves.length === 2 ? parse(halves[1]!) : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest]
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  return groups
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`

function v6Blocked(ip: string, policy: OutboundPolicy): BlockReason | null {
  const g = v6Groups(ip)
  if (!g) return 'reserved'
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeroTo(8)) return 'unspecified'
  if (zeroTo(7) && g[7] === 1) return policy.allowLoopback ? null : 'loopback'
  // IPv4-translated (::ffff:0:a.b.c.d, SIIT), Teredo (2001::/32), site-local (fec0::/10) and the local-use NAT64
  // prefix (64:ff9b:1::/48) can all reach addresses the rules above would refuse: blocked outright.
  if (zeroTo(4) && g[4] === 0xffff && g[5] === 0) return 'reserved'
  if (g[0] === 0x2001 && g[1] === 0) return 'reserved'
  if ((g[0]! & 0xffc0) === 0xfec0) return 'reserved'
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'reserved'
  // IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4) is judged as that IPv4.
  if (zeroTo(5) && g[5] === 0xffff) return v4Blocked(v4Of(g[6]!, g[7]!), policy)
  if (zeroTo(6)) return v4Blocked(v4Of(g[6]!, g[7]!), policy)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(v4Of(g[6]!, g[7]!), policy)
  if (g[0] === 0x2002) return v4Blocked(v4Of(g[1]!, g[2]!), policy)
  // AWS IMDS over IPv6.
  if (g[0] === 0xfd00 && g[1] === 0xec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return 'metadata'
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local'
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast'
  return null
}

/** Why core must not connect to this IP address, or null when it may. */
export function addressBlocked(ip: string, policy: OutboundPolicy): BlockReason | 'internal' | null {
  if (policy.blockedAddresses?.has(ip.toLowerCase())) return 'internal'
  const kind = isIP(ip)
  if (kind === 4) return v4Blocked(ip, policy)
  if (kind === 6) return v6Blocked(ip, policy)
  return 'reserved'
}

export function isLoopback(ip: string): boolean {
  return addressBlocked(ip, {}) === 'loopback'
}

/** RFC 1918, ULA and loopback: where plain http is acceptable ("internal" hosts). */
export function isInternalAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = v4Octets(ip) as [number, number]
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127
  }
  const g = v6Groups(ip)
  if (!g) return false
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isInternalAddress(v4Of(g[6]!, g[7]!))
  return (g[0]! & 0xfe00) === 0xfc00
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OutboundError('timeout')), Math.max(ms, 1))
    }),
  ]).finally(() => clearTimeout(timer))
}

export type ResolvedTarget = {
  address: string
  family: number
  private: boolean
  /** Every checked address in resolver order (`address` is the first); safeFetch tries the next one when a connection is refused. */
  addresses: { address: string; family: number }[]
}

/** Resolves a host once and checks every address; the caller connects to `address` (or each of `addresses`). */
export async function resolveOutbound(rawHost: string, policy: OutboundPolicy = {}, timeoutMs = 5_000): Promise<ResolvedTarget> {
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) throw new OutboundError('invalid_url')
  // Decimal, octal and hex IPv4 forms (2852039166, 0251.0376.0251.0376, 0xa9fea9fe) as the URL parser reads them,
  // so they are checked as the address the resolver would turn them into.
  if (!isIP(host)) {
    try {
      host = new URL(`http://${host}`).hostname
    } catch {
      throw new OutboundError('invalid_url')
    }
  }
  const literal = isIP(host)
  if (!literal) {
    if (BLOCKED_HOSTS.has(host)) throw new OutboundError('blocked_host')
    if ((host === 'localhost' || host.endsWith('.localhost')) && !policy.allowLoopback) throw new OutboundError('blocked_host')
  }
  let addrs: { address: string; family: number }[]
  if (literal) addrs = [{ address: host, family: literal }]
  else {
    try {
      addrs = await withTimeout(policy.lookup ? policy.lookup(host) : dnsLookup(host, { all: true, verbatim: true }), timeoutMs)
    } catch (err) {
      throw err instanceof OutboundError ? err : new OutboundError('dns_failed')
    }
    if (!addrs.length) throw new OutboundError('dns_failed')
  }
  if (addrs.some((a) => addressBlocked(a.address, policy) !== null)) throw new OutboundError('blocked_address')
  const first = addrs[0]!
  return {
    address: first.address,
    family: first.family,
    private: addrs.every((a) => isInternalAddress(a.address)),
    addresses: addrs.map((a) => ({ address: a.address, family: a.family })),
  }
}

export type SafeResponse = { status: number; headers: http.IncomingHttpHeaders; body: string }

export type SafeFetchOptions = {
  method?: 'GET' | 'POST' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  /** Whole request (default 10 s). */
  timeoutMs?: number
  /** Until the TCP (and TLS) connection is up (default 5 s). */
  connectTimeoutMs?: number
  /** Response bytes read at most (default 64 KB); more is `too_large`. */
  maxBytes?: number
  policy?: OutboundPolicy
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_OSSL|HOSTNAME_MISMATCH)/

function mapError(err: unknown): OutboundError {
  if (err instanceof OutboundError) return err
  const c = (err as { code?: unknown })?.code
  if (typeof c === 'string' && TLS_CODE.test(c)) return new OutboundError('tls_failed')
  if (c === 'ETIMEDOUT') return new OutboundError('timeout')
  return new OutboundError('connect_failed')
}

/** One HTTP(S) request through the rules above. Non-2xx statuses (3xx too) are returned, not thrown. */
export async function safeFetch(rawUrl: string | URL, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new OutboundError('invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundError('scheme_not_allowed')
  if (url.username || url.password) throw new OutboundError('invalid_url')
  const policy = opts.policy ?? {}
  // The DNS lookup counts against the whole request's time.
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  const target = await resolveOutbound(url.hostname, policy, Math.min(opts.connectTimeoutMs ?? 5_000, deadline - Date.now()))
  if (url.protocol === 'http:' && !target.private) throw new OutboundError('https_required')
  const secure = url.protocol === 'https:'
  const hostName = url.hostname.replace(/^\[|\]$/g, '')
  const maxBytes = opts.maxBytes ?? 64 * 1024

  // A name with several checked addresses (localhost → ::1 and 127.0.0.1, or a dual-stack host whose IPv6 is not
  // served) moves to the next address when the connection itself is refused or unreachable, within the deadline.
  // Only addresses resolveOutbound already checked are tried; nothing is looked up again.
  for (let i = 0; ; i++) {
    const addr = target.addresses[i] ?? target
    try {
      return await attempt(addr)
    } catch (err) {
      const next = err instanceof NextAddress && i + 1 < target.addresses.length && Date.now() < deadline
      if (!next) throw err instanceof NextAddress ? err.cause : err
    }
  }

  function attempt(addr: { address: string; family: number }): Promise<SafeResponse> {
    return new Promise<SafeResponse>((resolve, reject) => {
      let settled = false
      let connected = false
      const fail = (e: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(total)
        req.destroy()
        const code = (e as { code?: unknown })?.code
        if (!connected && typeof code === 'string' && RETRY_NEXT.has(code)) reject(new NextAddress(mapError(e)))
        else reject(mapError(e))
      }
      const reqOpts: https.RequestOptions = {
        method: opts.method ?? 'GET',
        host: addr.address,
        family: addr.family,
        port: url.port ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, 'user-agent': 'yoda-settings-test', ...opts.headers },
        agent: false,
        ...(secure && !isIP(hostName) ? { servername: hostName } : {}),
      }
      const req = (secure ? https : http).request(reqOpts, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) return fail(new OutboundError('too_large'))
          chunks.push(c)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(total)
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', fail)
      })
      const total = setTimeout(() => fail(new OutboundError('timeout')), Math.max(deadline - Date.now(), 1))
      req.on('socket', (socket) => {
        const connect = setTimeout(() => fail(new OutboundError('timeout')), opts.connectTimeoutMs ?? 5_000)
        socket.once('connect', () => (connected = true))
        socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connect))
        socket.once('close', () => clearTimeout(connect))
      })
      req.on('error', fail)
      if (opts.body !== undefined) req.write(opts.body)
      req.end()
    })
  }
}

/** Connection-level failures after which safeFetch tries the next checked address. */
const RETRY_NEXT = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])

class NextAddress extends Error {
  constructor(readonly cause: OutboundError) {
    super(cause.message)
  }
}

/** The compose services core sits next to (§8.5); their addresses are blocked as well as their names. */
export const COMPOSE_SERVICES = ['postgres', 'rustfs', 'core', 'portal', 'backup', 'migrate', 'runner'] as const

/**
 * Core's own interface addresses and what the compose service names resolve to now, for
 * `OutboundPolicy.blockedAddresses` (boot, best effort: a name that does not resolve is skipped, and a container
 * that restarts later may get an address not in the list).
 */
export async function internalAddresses(
  lookup: (host: string) => Promise<{ address: string }[]> = (h) => dnsLookup(h, { all: true, verbatim: true }),
  interfaces: () => NodeJS.Dict<{ address: string; internal: boolean }[]> = networkInterfaces,
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const list of Object.values(interfaces())) for (const i of list ?? []) if (!i.internal) out.add(i.address.toLowerCase())
  await Promise.all(
    COMPOSE_SERVICES.map(async (name) => {
      try {
        for (const a of await withTimeout(lookup(name), 2_000)) out.add(a.address.toLowerCase())
      } catch {
        // Not running in compose (dev), or the service is not up.
      }
    }),
  )
  return out
}
