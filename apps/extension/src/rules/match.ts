import { matchesPattern, patternSpecificity } from '@yoda/shared'

/** Where a rule came from: managed policy, a Yoda's /extension/mappings, or the tester's own options page. */
export type RuleSource = 'policy' | 'yoda' | 'mine'

export type Rule = {
  id: string
  pattern: string
  profileId: string
  projectId: string | null
  environment: string | null
  production: boolean
  source: RuleSource
  order: number
}

/** What the mapping needs of each connected Yoda's session: its member projects and their repos. */
export type SessionView = { profileId: string; isDefault: boolean; projects: { id: string; repos: string[] }[] }

/** 1 when the pattern names a port (`http://localhost:3000/*`); a port-less one matches every port. */
const hasPort = (p: string) => (/^[^:]+:\/\/[^/]*:\d+\//.test(p) ? 1 : 0)

const SOURCE_RANK: Record<RuleSource, number> = { policy: 0, yoda: 1, mine: 2 }

/** Negative when `a` wins over `b`, with the reason it won. */
function compare(a: Rule, b: Rule): [number, string] {
  const [ah, ap] = patternSpecificity(a.pattern)
  const [bh, bp] = patternSpecificity(b.pattern)
  if (ah !== bh) return [bh - ah, 'more specific host']
  const ports = hasPort(b.pattern) - hasPort(a.pattern)
  if (ports) return [ports, 'a port given']
  if (ap !== bp) return [bp - ap, 'longer path']
  if (a.source !== b.source) return [SOURCE_RANK[a.source] - SOURCE_RANK[b.source], `source ${a.source} before ${b.source}`]
  if (a.order !== b.order) return [a.order - b.order, 'lower order']
  return [0, 'tie (first listed)']
}

/**
 * The rule for a URL (decision 3): of the rules whose pattern matches, the most specific (literal host over
 * wildcard, longer host, longer path), then policy over yoda over mine, then the lower order. `why` says, for each
 * other matching rule, why the winner beat it (the options page's URL tester shows it).
 */
export function pickRule(url: string, rules: Rule[]): { rule: Rule; why: string[] } | null {
  const matching = rules.filter((r) => matchesPattern(r.pattern, url))
  if (!matching.length) return null
  const winner = matching.reduce((best, r) => (compare(r, best)[0] < 0 ? r : best))
  const why = matching.filter((r) => r !== winner).map((r) => `${winner.pattern} (${winner.source}) over ${r.pattern} (${r.source}): ${compare(winner, r)[1]}`)
  return { rule: winner, why: why.length ? why : [`${winner.pattern} (${winner.source}): the only match`] }
}

/**
 * The project to report to. With a rule: its project, but only one that is a member project of the rule's own
 * profile (a Yoda's rules never point into another Yoda, T11). Without a rule: the page's build repo mapped to a
 * member project of the default profile. Otherwise null (the popup's picker then lists only reportable projects).
 */
export function projectFor(
  url: string,
  build: { repo?: string | null } | null,
  rules: Rule[],
  sessions: SessionView[],
): { profileId: string; projectId: string; via: 'rule'; ruleId: string } | { profileId: string; projectId: string; via: 'repo' } | null {
  const picked = pickRule(url, rules)
  if (picked) {
    const { rule } = picked
    const own = sessions.find((s) => s.profileId === rule.profileId)
    if (rule.projectId && own?.projects.some((p) => p.id === rule.projectId)) return { profileId: rule.profileId, projectId: rule.projectId, via: 'rule', ruleId: rule.id }
    return null
  }
  const repo = build?.repo?.trim()
  const def = sessions.find((s) => s.isDefault)
  if (!repo || !def) return null
  const project = def.projects.find((p) => p.repos.includes(repo))
  return project ? { profileId: def.profileId, projectId: project.id, via: 'repo' } : null
}

/**
 * A production site (no video, logs off by default): the winning rule says so, or any matching policy or Yoda rule
 * does. The tester's own rule can never take the mark away.
 */
export function isProduction(url: string, rules: Rule[]): boolean {
  if (pickRule(url, rules)?.rule.production) return true
  return rules.some((r) => r.production && r.source !== 'mine' && matchesPattern(r.pattern, url))
}
