import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const file = new URL('../../../docker-compose.prod.yml', import.meta.url)

/** (Compose's `!reset` / `!override` tags are left unresolved.) The prod compose `core` service's `environment:` block, as written (interpolation not applied). */
export function prodComposeCoreRaw(): Record<string, string> {
  const doc = parse(readFileSync(file, 'utf8'), { logLevel: 'error' }) as { services: { core: { environment: Record<string, string | number> } } }
  return Object.fromEntries(Object.entries(doc.services.core.environment).map(([k, v]) => [k, String(v)]))
}

/**
 * Core's env as `docker compose` builds it from the prod overlay and a host `.env` (`${NAME}`, `${NAME:-x}`,
 * `${NAME-x}`; `$$` is a literal `$`). Unset names interpolate to ''. Nothing else (no shell env) leaks in.
 */
export function prodComposeCoreEnv(dotenv: Record<string, string> = {}): Record<string, string> {
  const sub = (v: string) =>
    v.replace(/\$\$|\$\{([A-Z_][A-Z0-9_]*)(?:(:?)([-?])([^}]*))?\}/g, (m, name: string | undefined, colon: string, op: string, arg: string) => {
      if (m === '$$') return '$'
      const val = dotenv[name!]
      const unset = val === undefined || (colon === ':' && val === '')
      if (op === '-' && unset) return arg
      if (op === '?' && unset) throw new Error(`${name} is required`)
      return val ?? ''
    })
  return Object.fromEntries(Object.entries(prodComposeCoreRaw()).map(([k, v]) => [k, sub(v)]))
}
