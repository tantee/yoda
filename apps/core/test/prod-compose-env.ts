import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const file = new URL('../../../docker-compose.prod.yml', import.meta.url)

/** (Compose's `!reset` / `!override` tags are left unresolved.) The prod compose `core` service's `environment:` block, as written (interpolation not applied). */
export function prodComposeCoreRaw(): Record<string, string> {
  const doc = parse(readFileSync(file, 'utf8'), { logLevel: 'error' }) as { services: { core: { environment: Record<string, string | number> } } }
  return Object.fromEntries(Object.entries(doc.services.core.environment).map(([k, v]) => [k, String(v)]))
}

/**
 * Compose interpolation of one value (`${NAME}`, `${NAME:-x}`, `${NAME-x}`, `${NAME:?x}`, `${NAME:+x}`, `${NAME+x}`,
 * nested in the argument as compose allows; `$$` is a literal `$`). Unset names interpolate to ''.
 */
export function interpolate(v: string, dotenv: Record<string, string>): string {
  let out = ''
  let i = 0
  while (i < v.length) {
    if (v.startsWith('$$', i)) {
      out += '$'
      i += 2
      continue
    }
    if (!v.startsWith('${', i)) {
      out += v[i]
      i += 1
      continue
    }
    // The matching brace, counting nested ${...}.
    let depth = 1
    let j = i + 2
    while (j < v.length && depth > 0) {
      if (v.startsWith('${', j)) {
        depth += 1
        j += 2
        continue
      }
      if (v[j] === '}') depth -= 1
      j += 1
    }
    const body = v.slice(i + 2, j - 1)
    const m = /^([A-Z_][A-Z0-9_]*)(?:(:?)([-?+])([\s\S]*))?$/.exec(body)
    if (!m) throw new Error(`cannot interpolate ${v}`)
    const [, name, colon, op, arg = ''] = m
    const val = dotenv[name!]
    const unset = val === undefined || (colon === ':' && val === '')
    if (op === '-') out += unset ? interpolate(arg, dotenv) : val
    else if (op === '+') out += unset ? '' : interpolate(arg, dotenv)
    else if (op === '?' && unset) throw new Error(`${name} is required`)
    else out += val ?? ''
    i = j
  }
  return out
}

/**
 * Core's env as `docker compose` builds it from the prod overlay and a host `.env` (and release.env). Nothing else
 * (no shell env) leaks in.
 */
export function prodComposeCoreEnv(dotenv: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(prodComposeCoreRaw()).map(([k, v]) => [k, interpolate(v, dotenv)]))
}
