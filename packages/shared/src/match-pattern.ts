/**
 * Chrome match patterns (`<scheme>://<host><path>`), the form of project application URLs and URL-mapping rules.
 * Schemes are http, https or `*` (both); the host is `*`, `*.` plus a host, or a host, with an optional port (a
 * port-less pattern matches any port, as in Chrome); the path starts with `/` and `*` matches anything. There is no
 * `<all_urls>`. The path is matched against the URL's path and query.
 */
export type MatchPattern = { scheme: 'http' | 'https' | '*'; host: string; path: string }

const PATTERN_RE = /^(\*|https?):\/\/([^/]+)(\/.*)$/
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST_RE = new RegExp(`^(?:\\*|(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*)(?::([0-9]{1,5}))?$`)

export function parseMatchPattern(p: string): MatchPattern | null {
  const m = PATTERN_RE.exec(p)
  if (!m) return null
  const host = m[2]!.toLowerCase()
  const path = m[3]!
  const h = HOST_RE.exec(host)
  if (!h) return null
  if (h[1] !== undefined) {
    const port = Number(h[1])
    if (port < 1 || port > 65535) return null
  }
  if (/\s/.test(path)) return null
  return { scheme: m[1] as MatchPattern['scheme'], host, path }
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }

export function matchesPattern(p: string, url: string): boolean {
  const pattern = parseMatchPattern(p)
  if (!pattern) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (pattern.scheme !== '*' && `${pattern.scheme}:` !== u.protocol) return false

  const [hostPart, portPart] = pattern.host.split(':') as [string, string | undefined]
  if (portPart !== undefined && Number(portPart) !== Number(u.port || DEFAULT_PORT[u.protocol])) return false
  const hostname = u.hostname.toLowerCase()
  if (hostPart !== '*') {
    if (hostPart.startsWith('*.')) {
      const base = hostPart.slice(2)
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false
    } else if (hostname !== hostPart) return false
  }

  const re = new RegExp(`^${pattern.path.split('*').map(escape).join('.*')}$`)
  return re.test(`${u.pathname}${u.search}`)
}

/**
 * How specific a pattern is, compared as a tuple (higher wins): a literal host outranks any wildcard host, a longer
 * host outranks a shorter one, then the longer literal path wins. An invalid pattern ranks lowest.
 */
export function patternSpecificity(p: string): [hostScore: number, pathLength: number] {
  const pattern = parseMatchPattern(p)
  if (!pattern) return [-1, -1]
  const host = pattern.host.split(':')[0]!
  const hostScore = host === '*' ? 0 : host.startsWith('*.') ? host.length - 2 : 1000 + host.length
  return [hostScore, pattern.path.replace(/\*/g, '').length]
}
