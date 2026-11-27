import type { ProxyStatus } from '@yoda/shared'
import { connect, type PeerCertificate } from 'node:tls'
import type { Config } from './config.js'

/**
 * The built-in HTTPS proxy as core sees it, for the setup wizard's read-only status card (docs/operations.md,
 * section 4b). Core opens a TLS handshake to the `proxy` service on the compose network for the configured name and
 * reads the certificate it presents: the same public facts any browser sees (subject, issuer, names, validity,
 * fingerprint). It never reads the proxy's files: its volume holds the internal CA's private key and is mounted in
 * the proxy only. The handshake does not check the chain (an internal CA is not in core's trust store); nothing is
 * sent over it.
 */
export type ProxyProbe = (target: { host: string; port: number; servername: string; timeoutMs: number }) => Promise<
  { ok: true; cert: PeerCertificate } | { ok: false; error: string }
>

/** The `proxy` service on the compose network. */
export const PROXY_HOST = 'proxy'

export const tlsProbe: ProxyProbe = ({ host, port, servername, timeoutMs }) =>
  new Promise((resolve) => {
    let done = false
    const finish = (r: Awaited<ReturnType<ProxyProbe>>) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(r)
    }
    // rejectUnauthorized: false: the card reports the certificate, it does not trust it (an internal CA's root is
    // on the staff PCs, not in core's store). ALPN http/1.1 only; no request is written.
    const socket = connect({ host, port, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }))
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      finish(cert && Object.keys(cert).length > 0 ? { ok: true, cert } : { ok: false, error: 'tls_failed' })
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'not_found' : 'tls_failed'
      finish({ ok: false, error: code })
    })
  })

const nameOf = (dn: PeerCertificate['subject'] | undefined): string => {
  if (!dn) return ''
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''))
  const cn = pick(dn.CN)
  const o = pick(dn.O)
  return [cn, o && o !== cn ? o : ''].filter(Boolean).join(' · ')
}

const namesOf = (cert: PeerCertificate): string[] =>
  (cert.subjectaltname ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:') || s.startsWith('IP Address:'))
    .map((s) => s.replace(/^DNS:|^IP Address:/, ''))

const iso = (s: string | undefined): string => {
  const d = s ? new Date(s) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
}

export async function proxyStatus(config: Config, probe: ProxyProbe = tlsProbe, timeoutMs = 3000): Promise<ProxyStatus> {
  const hops = config.trustedProxyHops ?? 1
  const p = config.proxy
  if (!p) return { enabled: false, domain: null, certMode: null, publicUrl: null, trustedProxyHops: hops, reachable: null, error: null, certificate: null }
  const publicUrl = p.domain ? `https://${p.domain}${p.httpsPort === 443 ? '' : `:${p.httpsPort}`}` : null
  const base = { enabled: true, domain: p.domain, certMode: p.certMode, publicUrl, trustedProxyHops: hops }
  if (!p.domain) return { ...base, reachable: false, error: 'no_domain', certificate: null }
  const r = await probe({ host: PROXY_HOST, port: p.httpsPort, servername: p.domain, timeoutMs })
  if (!r.ok) return { ...base, reachable: false, error: r.error, certificate: null }
  const c = r.cert
  return {
    ...base,
    reachable: true,
    error: null,
    certificate: {
      subject: nameOf(c.subject),
      issuer: nameOf(c.issuer),
      names: namesOf(c),
      validFrom: iso(c.valid_from),
      validTo: iso(c.valid_to),
      fingerprint256: c.fingerprint256 ?? '',
    },
  }
}
