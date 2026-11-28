// Checks a release output (dist/ or the zip) before it ships (plan B13): the proposal §5 manifest rules, no e2e-only
// code, no eval or remote code, no private key, and the version. `tsx scripts/check-dist.ts [dir|zip ...]`; with no
// argument it checks dist/ and every zip in release/. Exits 1 with one line per problem.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import {
  FORBIDDEN_MANIFEST_KEYS,
  FORBIDDEN_PERMISSIONS,
  OPTIONAL_HOST_PERMISSIONS,
  OPTIONAL_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from '../src/manifest'
import { E2E_TAB_TARGET } from '../src/popup/e2e-marker'

type Files = Map<string, Buffer>

function read(path: string): Files {
  const files: Files = new Map()
  if (statSync(path).isDirectory()) {
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else files.set(relative(path, p).split('\\').join('/'), readFileSync(p))
      }
    }
    walk(path)
  } else {
    for (const [name, bytes] of Object.entries(unzipSync(readFileSync(path)))) if (!name.endsWith('/')) files.set(name, Buffer.from(bytes))
  }
  return files
}

const PRIVATE_KEY = /-----BEGIN ((RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/
const EVAL = /(?<![\w$.])eval\s*\(/
const NEW_FUNCTION = /\bnew\s+Function\s*\(/
const REMOTE = [
  /\bimportScripts\s*\(\s*["'`](https?:)?\/\//,
  /\bimport\s*\(\s*["'`](https?:)?\/\//,
  /\bfrom\s*["'`](https?:)?\/\//,
  /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i,
]

const subset = (got: unknown, allowed: readonly string[]) => (Array.isArray(got) ? got.filter((p) => !allowed.includes(String(p))) : [])

function checkManifest(m: Record<string, unknown>, version: string): string[] {
  const issues: string[] = []
  if (m.manifest_version !== 3) issues.push(`manifest_version is ${String(m.manifest_version)}, not 3`)
  for (const key of FORBIDDEN_MANIFEST_KEYS) if (key in m) issues.push(`manifest has ${key}`)
  for (const p of subset(m.permissions, REQUIRED_PERMISSIONS)) issues.push(`permissions has ${p}`)
  for (const p of subset(m.optional_permissions, OPTIONAL_PERMISSIONS)) issues.push(`optional_permissions has ${p}`)
  for (const p of subset(m.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS)) issues.push(`optional_host_permissions has ${p}`)
  const all = [m.permissions, m.optional_permissions].flatMap((l) => (Array.isArray(l) ? l.map(String) : []))
  for (const p of FORBIDDEN_PERMISSIONS) if (all.includes(p)) issues.push(`forbidden permission ${p}`)
  // The default MV3 policy forbids eval and remote code; any explicit policy is a change to review, not to ship.
  if ('content_security_policy' in m) issues.push('manifest sets content_security_policy')
  if (m.version_name !== version) issues.push(`version_name ${String(m.version_name)} is not the package version ${version}`)
  return issues
}

/** Every problem in a release output (a directory or a zip); empty when it may ship. */
export function checkDist(path: string, version: string): string[] {
  if (!existsSync(path)) return [`${path} does not exist`]
  const files = read(path)
  const issues: string[] = []
  const manifest = files.get('manifest.json')
  if (!manifest) issues.push('no manifest.json')
  else {
    try {
      issues.push(...checkManifest(JSON.parse(manifest.toString('utf8')) as Record<string, unknown>, version))
    } catch {
      issues.push('manifest.json is not JSON')
    }
  }
  for (const [name, bytes] of files) {
    const text = bytes.toString('latin1')
    if (PRIVATE_KEY.test(text)) issues.push(`private key in ${name}`)
    if (!/\.(js|mjs|html|json)$/.test(name)) continue
    if (text.includes('<all_urls>')) issues.push(`<all_urls> in ${name} (the e2e build?)`)
    if (text.includes(E2E_TAB_TARGET)) issues.push(`E2E_TAB_TARGET marker in ${name} (the e2e ?tab= target)`)
    if (/\.(js|mjs)$/.test(name)) {
      if (EVAL.test(text)) issues.push(`eval( in ${name}`)
      if (NEW_FUNCTION.test(text)) issues.push(`new Function( in ${name}`)
    }
    if (/\.(js|mjs|html)$/.test(name) && REMOTE.some((r) => r.test(text))) issues.push(`remote script loaded in ${name}`)
  }
  return issues
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
  const release = join(root, 'release')
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [join(root, 'dist'), ...(existsSync(release) ? readdirSync(release).filter((f) => f.endsWith('.zip')).map((f) => join(release, f)) : [])]
  let failed = false
  for (const t of targets) {
    const issues = checkDist(t, version)
    for (const i of issues) console.error(`${relative(process.cwd(), t) || t}: ${i}`)
    if (issues.length) failed = true
    else console.log(`${relative(process.cwd(), t) || t}: ok`)
  }
  process.exit(failed ? 1 : 0)
}
