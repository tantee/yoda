/**
 * The X-Forwarded-* headers the portal's /api proxy sends to core (installer proposal §8.3; Task 7 proxy note).
 * Core trusts them from one internal hop per YODA_TRUSTED_PROXY_HOPS (default 1, the portal alone).
 *
 * - The client address: the peer the portal saw is always appended, so a browser cannot choose its own for core's
 *   rate limits and audit log (core believes only `hops` entries from the right).
 * - Host: with hops = 1 the portal's own Host header, never an X-Forwarded-Host a browser sent. With hops > 1 a
 *   reverse proxy in front sets it and the portal passes it on (falling back to its own Host).
 * - Scheme: an incoming `X-Forwarded-Proto: https` is honoured even with hops = 1, as an upgrade only: TLS is often
 *   terminated by a proxy the admin has not counted yet, and a browser claiming https only makes its own cookies
 *   `Secure` (stricter). It never downgrades: a TLS socket is https whatever arrives. With hops > 1 the proxy's
 *   value is passed on.
 *
 * The host decides the setup wizard's detected public URL, the Origin check and the localhost rule for TOTP (D3).
 */
export type ForwardInput = {
  peer: string
  /** The portal's own socket is TLS. */
  encrypted: boolean
  headers: { forwardedFor?: string; forwardedProto?: string; forwardedHost?: string; host?: string }
  hops: number
}

/** YODA_TRUSTED_PROXY_HOPS as the portal reads it (1–5, default 1; anything else counts as 1). */
export function trustedHops(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1
}

export function forwardedHeaders(i: ForwardInput): Record<string, string> {
  const own = { proto: i.encrypted ? 'https' : 'http', host: i.headers.host ?? '' }
  const outer = i.hops > 1
  const claimed = i.headers.forwardedProto?.split(',')[0]?.trim().toLowerCase()
  const proto = i.encrypted ? 'https' : outer ? (claimed === 'https' || claimed === 'http' ? claimed : own.proto) : claimed === 'https' ? 'https' : own.proto
  return {
    'x-forwarded-for': i.headers.forwardedFor ? `${i.headers.forwardedFor}, ${i.peer}` : i.peer,
    'x-forwarded-proto': proto,
    'x-forwarded-host': (outer && i.headers.forwardedHost) || own.host,
  }
}
