import type { DefectBuild, MappingRule } from '@yoda/shared'

/** The build fields a page can state (proposal §6.1); `built` is the convention's name for builtAt. */
const KEYS: Record<string, keyof Omit<DefectBuild, 'source'>> = { repo: 'repo', branch: 'branch', commit: 'commit', env: 'env', built: 'builtAt' }
const MAX = 200

type Fields = Partial<Omit<DefectBuild, 'source'>>

/**
 * `repo=group/app;branch=feature%3Bx;commit=3f9c2e1;env=uat;built=…`: the meta tag and X-Yoda-Build format.
 * Values are percent-decoded; unknown keys, empty values and undecodable values are dropped; each is cut to 200.
 */
export function parseYodaBuild(content: string): Fields {
  const out: Fields = {}
  for (const pair of content.split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const key = KEYS[pair.slice(0, at).trim()]
    if (!key) continue
    let value: string
    try {
      value = decodeURIComponent(pair.slice(at + 1)).trim()
    } catch {
      continue
    }
    if (value) out[key] = value.slice(0, MAX)
  }
  return out
}

/** The same fields from /.well-known/yoda-build.json: string values only. */
function fromJson(v: unknown): Fields {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Fields = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const key = KEYS[k] ?? (k === 'builtAt' ? 'builtAt' : undefined)
    if (key && typeof raw === 'string' && raw.trim()) out[key] = raw.trim().slice(0, MAX)
  }
  return out
}

const some = (f: Fields) => Object.keys(f).length > 0

/** The page's build, by precedence: meta tag, well-known file, response header, GitLab deployment. */
export function detectBuild(sources: { meta: string | null; wellKnown: unknown | null; headers: string[]; gitlab: MappingRule['build'] }): DefectBuild | null {
  const meta = sources.meta ? parseYodaBuild(sources.meta) : {}
  if (some(meta)) return { ...meta, source: 'meta' }
  const known = fromJson(sources.wellKnown)
  if (some(known)) return { ...known, source: 'well-known' }
  for (const h of sources.headers) {
    const f = parseYodaBuild(h)
    if (some(f)) return { ...f, source: 'header' }
  }
  const g = sources.gitlab
  if (g) {
    const f: Fields = { repo: g.repo.slice(0, MAX) }
    if (g.ref) f.branch = g.ref.slice(0, MAX)
    if (g.sha) f.commit = g.sha.slice(0, MAX)
    if (g.deployedAt) f.builtAt = g.deployedAt
    return { ...f, source: 'gitlab' }
  }
  return null
}
