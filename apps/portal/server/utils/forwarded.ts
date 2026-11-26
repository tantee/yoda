/**
 * The X-Forwarded-* headers the portal's /api proxy sends to core (installer proposal §8.3; Task 7 proxy note).
 * Core trusts them from one internal hop per YODA_TRUSTED_PROXY_HOPS (default 1, the portal alone).
 *
 * - The client address: the peer the portal saw is always appended, so a browser cannot choose its own for core's
 *   rate limits and audit log (core believes only `hops` entries from the right).
 * - Scheme and host: with hops = 1 there is no outer proxy, so whatever a browser sent is its own claim: the portal
 *   sets both from what it sees itself (its socket and its own Host header). With hops > 1 a reverse proxy in front
 *   sets them, and the portal passes them on (falling back to its own view when one is missing).
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
  return {
    'x-forwarded-for': i.headers.forwardedFor ? `${i.headers.forwardedFor}, ${i.peer}` : i.peer,
    'x-forwarded-proto': (outer && i.headers.forwardedProto) || own.proto,
    'x-forwarded-host': (outer && i.headers.forwardedHost) || own.host,
  }
}
