import { ExtensionMappings, ExtensionSession, isTooBroadPattern, normalizeMatchPattern, parseMatchPattern } from '@yoda/shared'
import { detectBuild } from '../capture/build'
import type { PageMetadata } from '../capture/metadata'
import { isProduction, pickRule, projectFor, type Rule, type SessionView } from '../rules/match'
import { yodaFetch } from './api'
import { profiles } from './store'

/**
 * The rules the worker maps pages with (decision 3): each Yoda's /extension/mappings (cached per profile for its
 * ttl, refreshed when the popup opens), the tester's own rules from the options page, and managed policy rules
 * (phase 3). Yoda rules always carry the profile they came from (T11).
 */

type Cached = { at: number; ttlMs: number; rules: Rule[] }
const cacheKey = (profileId: string) => `mappings.${profileId}`
export const MINE_KEY = 'rules.mine'

export async function yodaRules(profileId: string, opts: { refresh?: boolean; now?: number } = {}): Promise<Rule[]> {
  const now = opts.now ?? Date.now()
  const key = cacheKey(profileId)
  const cached = (await chrome.storage.local.get(key))[key] as Cached | undefined
  if (cached && !opts.refresh && now - cached.at < cached.ttlMs) return cached.rules
  try {
    const res = await yodaFetch(profileId, '/api/extension/mappings')
    if (!res.ok) return cached?.rules ?? []
    const body = ExtensionMappings.parse(await res.json())
    const rules: Rule[] = body.rules.map((r, i) => ({
      id: `yoda:${profileId}:${i}`,
      pattern: r.pattern,
      profileId,
      projectId: r.projectId,
      environment: r.environment,
      production: r.production,
      source: 'yoda',
      order: i,
    }))
    await chrome.storage.local.set({ [key]: { at: now, ttlMs: body.ttlSeconds * 1000, rules } satisfies Cached })
    return rules
  } catch {
    // Offline: the last known rules (production marks included) still apply.
    return cached?.rules ?? []
  }
}

export async function forgetYodaRules(profileId: string): Promise<void> {
  await chrome.storage.local.remove(cacheKey(profileId))
}

export async function mineRules(): Promise<Rule[]> {
  const v = (await chrome.storage.local.get(MINE_KEY))[MINE_KEY]
  return Array.isArray(v) ? (v as Rule[]).map((r) => ({ ...r, source: 'mine' as const })) : []
}

export async function policyRules(): Promise<Rule[]> {
  try {
    const v = (await chrome.storage.managed.get('rules'))?.rules
    return Array.isArray(v) ? (v as Rule[]).map((r, i) => ({ ...r, id: `policy:${i}`, source: 'policy' as const, order: i })) : []
  } catch {
    return []
  }
}

async function cachedRules(profileId: string): Promise<Rule[] | null> {
  const v = (await chrome.storage.local.get(cacheKey(profileId)))[cacheKey(profileId)] as Cached | undefined
  return v ? v.rules : null
}

/**
 * Whether a page is a production site, for the video and log defaults (decision 3). Fails closed: every known
 * production mark counts (each stored profile's cached Yoda rules, reconnect-pending ones too, and every policy
 * rule, whatever profile it names), and the answer is `unknown` when the URL is not a readable web address or a
 * connected Yoda's mappings were never fetched. Video is allowed only on `ok`.
 */
export async function productionVerdict(url: string): Promise<'production' | 'ok' | 'unknown'> {
  if (!/^https?:\/\//i.test(url)) return 'unknown'
  let complete = true
  const rules: Rule[] = [...(await policyRules())]
  for (const p of await profiles()) {
    const yoda = p.needsReconnect ? await cachedRules(p.id) : ((await yodaRules(p.id).catch(() => null)) && (await cachedRules(p.id)))
    if (yoda) rules.push(...yoda)
    else if (!p.needsReconnect) complete = false
  }
  if (isProduction(url, rules)) return 'production'
  return complete ? 'ok' : 'unknown'
}

/** Every rule of every connected (not reconnect-pending) profile, mine and policy included. */
export async function allRules(opts: { refresh?: boolean } = {}): Promise<Rule[]> {
  const list = (await profiles()).filter((p) => !p.needsReconnect)
  const ids = new Set(list.map((p) => p.id))
  const yoda = (await Promise.all(list.map((p) => yodaRules(p.id, opts)))).flat()
  // A rule pointing at a removed profile maps nothing.
  const own = [...(await policyRules()), ...(await mineRules())].filter((r) => ids.has(r.profileId))
  return [...own, ...yoda]
}

export type MineRuleInput = { id?: string; pattern: string; profileId: string; projectId: string | null; environment: string | null }

/** Writes of my rules run one at a time (read-modify-write of one storage key). */
let mineQueue: Promise<unknown> = Promise.resolve()
function serialMine<T>(fn: () => Promise<T>): Promise<T> {
  const next = mineQueue.then(fn, fn)
  mineQueue = next.catch(() => {})
  return next
}

/** Rules from a Yoda or from policy: shown with a lock, never written by the options page. */
const isLocked = (id: string) => id.startsWith('yoda:') || id.startsWith('policy:')

/** Adds or edits one of my rules (validated, the pattern normalised). Mine are never production (decision 3). */
export function saveMineRule(input: MineRuleInput): Promise<{ ok: true; rule: Rule } | { ok: false; errors: string[] }> {
  return serialMine(() => writeMineRule(input))
}

async function writeMineRule(input: MineRuleInput): Promise<{ ok: true; rule: Rule } | { ok: false; errors: string[] }> {
  if (input.id && isLocked(input.id)) return { ok: false, errors: ['locked'] }
  const errors = validateRuleInput(input, (await profiles()).map((p) => p.id))
  if (errors.length) return { ok: false, errors }
  const list = await mineRules()
  const at = input.id ? list.findIndex((r) => r.id === input.id) : -1
  const rule: Rule = {
    id: at >= 0 ? list[at]!.id : `mine:${crypto.randomUUID()}`,
    pattern: normalizeMatchPattern(input.pattern),
    profileId: input.profileId,
    projectId: input.projectId,
    environment: input.environment?.trim() || null,
    production: false,
    source: 'mine',
    order: at >= 0 ? list[at]!.order : list.length,
  }
  if (at >= 0) list[at] = rule
  else list.push(rule)
  await chrome.storage.local.set({ [MINE_KEY]: list })
  return { ok: true, rule }
}

export function deleteMineRule(id: string): Promise<{ ok: true } | { ok: false; error: 'locked' }> {
  if (isLocked(id)) return Promise.resolve({ ok: false, error: 'locked' })
  return serialMine(async () => {
    const list = (await mineRules()).filter((r) => r.id !== id).map((r, i) => ({ ...r, order: i }))
    await chrome.storage.local.set({ [MINE_KEY]: list })
    return { ok: true as const }
  })
}

/** Errors for a rule the tester types in the options page (empty when it can be saved). */
export function validateRuleInput(r: { pattern: string; profileId: string; projectId: string | null }, profileIds: string[]): string[] {
  const errors: string[] = []
  const pattern = normalizeMatchPattern(r.pattern)
  if (!parseMatchPattern(pattern)) errors.push('pattern_invalid')
  else if (isTooBroadPattern(pattern)) errors.push('too_broad')
  if (!profileIds.includes(r.profileId)) errors.push('profile_unknown')
  return errors
}

async function sessionView(profileId: string, isDefault: boolean): Promise<SessionView | null> {
  try {
    const res = await yodaFetch(profileId, '/api/extension/session')
    if (!res.ok) return null
    const s = ExtensionSession.pick({ projects: true }).parse(await res.json())
    return { profileId, isDefault, projects: s.projects.map((p) => ({ id: p.id, repos: p.repos })) }
  } catch {
    return null
  }
}

export type Resolved = {
  production: boolean
  /** Video only where the page is known not to be production (productionVerdict `ok`). */
  videoAllowed: boolean
  profileId: string | null
  projectId: string | null
  via: 'rule' | 'repo' | null
  ruleId: string | null
  why: string[]
}

/**
 * What the popup starts from for a page: the profile and project the mapping picks (or the build's repo in the
 * default profile), and whether it is a production site. `readBuild` reads the page's build when no rule matches.
 */
export async function resolveUrl(url: string, opts: { refresh?: boolean; readBuild?: () => Promise<{ repo?: string | null } | null> } = {}): Promise<Resolved> {
  const rules = await allRules({ refresh: opts.refresh })
  const verdict = await productionVerdict(url).catch(() => 'unknown' as const)
  const production = verdict === 'production'
  const videoAllowed = verdict === 'ok'
  const picked = pickRule(url, rules)
  const list = await profiles()
  if (picked) {
    const p = list.find((x) => x.id === picked.rule.profileId)
    const view = p ? await sessionView(p.id, p.isDefault) : null
    const r = view ? projectFor(url, null, [picked.rule], [view]) : null
    return { production, videoAllowed, profileId: picked.rule.profileId, projectId: r?.projectId ?? null, via: r ? 'rule' : null, ruleId: picked.rule.id, why: picked.why }
  }
  const def = list.find((p) => p.isDefault && !p.needsReconnect)
  const build = def && opts.readBuild ? await opts.readBuild().catch(() => null) : null
  if (def && build?.repo) {
    const view = await sessionView(def.id, true)
    const r = view ? projectFor(url, build, [], [view]) : null
    if (r) return { production, videoAllowed, profileId: r.profileId, projectId: r.projectId, via: 'repo', ruleId: null, why: [] }
  }
  return { production, videoAllowed, profileId: null, projectId: null, via: null, ruleId: null, why: [] }
}

/** The repo of the page's build, from what the page itself says (meta, well-known, headers). */
export function repoOf(meta: PageMetadata | null | undefined): { repo: string | null } | null {
  if (!meta) return null
  const b = detectBuild({ ...meta.buildSources, gitlab: null })
  return b ? { repo: b.repo ?? null } : null
}
