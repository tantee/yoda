import { describe, expect, it } from 'vitest'
import { isProduction, pickRule, projectFor, type Rule, type SessionView } from '../src/rules/match'

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'
const P3 = '00000000-0000-4000-8000-000000000003'
let n = 0
const rule = (o: Partial<Rule> & { pattern: string }): Rule => ({
  id: `r${++n}`,
  profileId: 'yodaA',
  projectId: P1,
  environment: null,
  production: false,
  source: 'mine',
  order: 0,
  ...o,
})
const sessions: SessionView[] = [
  { profileId: 'yodaA', isDefault: true, projects: [{ id: P1, repos: ['his/opd'] }, { id: P2, repos: ['his/lab'] }] },
  { profileId: 'yodaB', isDefault: false, projects: [{ id: P3, repos: ['his/opd'] }] },
]

describe('pickRule', () => {
  it('only matching rules count', () => {
    expect(pickRule('https://other.example.org/', [rule({ pattern: 'https://app.example.org/*' })])).toBeNull()
  })

  it('a literal host beats a wildcard host', () => {
    const lit = rule({ pattern: 'https://app.example.org/*', projectId: P2 })
    const wild = rule({ pattern: 'https://*.example.org/*', source: 'policy' })
    const r = pickRule('https://app.example.org/x', [wild, lit])!
    expect(r.rule.id).toBe(lit.id)
    expect(r.why.join(' ')).toMatch(/host/)
  })

  it('a longer wildcard host beats a shorter one, then the longer path wins', () => {
    const a = rule({ pattern: 'https://*.example.org/*' })
    const b = rule({ pattern: 'https://*.uat.example.org/*' })
    expect(pickRule('https://opd.uat.example.org/', [a, b])!.rule.id).toBe(b.id)
    const short = rule({ pattern: 'https://app.example.org/*' })
    const long = rule({ pattern: 'https://app.example.org/opd/*' })
    const r = pickRule('https://app.example.org/opd/q', [short, long])!
    expect(r.rule.id).toBe(long.id)
    expect(r.why.join(' ')).toMatch(/path/)
  })

  it('equal specificity: policy, then yoda, then mine; then the lower order', () => {
    const mine = rule({ pattern: 'https://app.example.org/*', source: 'mine' })
    const yoda = rule({ pattern: 'https://app.example.org/*', source: 'yoda' })
    const policy = rule({ pattern: 'https://app.example.org/*', source: 'policy' })
    expect(pickRule('https://app.example.org/', [mine, yoda, policy])!.rule.id).toBe(policy.id)
    const r = pickRule('https://app.example.org/', [mine, yoda])!
    expect(r.rule.id).toBe(yoda.id)
    expect(r.why.join(' ')).toMatch(/source/)
    const m1 = rule({ pattern: 'https://app.example.org/*', order: 2 })
    const m2 = rule({ pattern: 'https://app.example.org/*', order: 1 })
    const o = pickRule('https://app.example.org/', [m1, m2])!
    expect(o.rule.id).toBe(m2.id)
    expect(o.why.join(' ')).toMatch(/order/)
  })

  it('a port-specific localhost rule beats a port-less one; http://localhost/* matches any port', () => {
    const any = rule({ pattern: 'http://localhost/*' })
    const p3000 = rule({ pattern: 'http://localhost:3000/*', projectId: P2 })
    expect(pickRule('http://localhost:5173/', [any, p3000])!.rule.id).toBe(any.id)
    expect(pickRule('http://localhost:3000/', [any, p3000])!.rule.id).toBe(p3000.id)
  })

  it('a mine rule for localhost loses to a more specific Yoda rule', () => {
    const mine = rule({ pattern: 'http://localhost/*', source: 'mine' })
    const yoda = rule({ pattern: 'http://localhost:3000/opd/*', source: 'yoda' })
    expect(pickRule('http://localhost:3000/opd/1', [mine, yoda])!.rule.id).toBe(yoda.id)
  })
})

describe('projectFor', () => {
  it("the rule's project, with its profile", () => {
    const r = rule({ pattern: 'https://app.example.org/*', projectId: P2 })
    expect(projectFor('https://app.example.org/', null, [r], sessions)).toEqual({ profileId: 'yodaA', projectId: P2, via: 'rule', ruleId: r.id })
  })

  it('a Yoda rule never maps to a project outside its own profile', () => {
    const r = rule({ pattern: 'https://app.example.org/*', source: 'yoda', profileId: 'yodaA', projectId: P3 })
    expect(projectFor('https://app.example.org/', null, [r], sessions)).toBeNull()
  })

  it('without a rule, build.repo maps to a member project of the default profile only', () => {
    expect(projectFor('https://x.example.org/', { repo: 'his/lab' }, [], sessions)).toEqual({ profileId: 'yodaA', projectId: P2, via: 'repo' })
    // his/opd is also in yodaB's project, but the default profile is yodaA.
    expect(projectFor('https://x.example.org/', { repo: 'his/opd' }, [], sessions)?.projectId).toBe(P1)
    expect(projectFor('https://x.example.org/', { repo: 'his/unknown' }, [], sessions)).toBeNull()
    expect(projectFor('https://x.example.org/', null, [], sessions)).toBeNull()
  })
})

describe('isProduction', () => {
  it('a production rule makes the popup state production', () => {
    expect(isProduction('https://app.example.org/', [rule({ pattern: 'https://app.example.org/*', production: true, source: 'yoda' })])).toBe(true)
    expect(isProduction('https://app.example.org/', [rule({ pattern: 'https://app.example.org/*' })])).toBe(false)
  })

  it("the tester's own rule cannot undo a Yoda or policy production mark", () => {
    const yoda = rule({ pattern: 'https://*.example.org/*', production: true, source: 'yoda' })
    const mine = rule({ pattern: 'https://app.example.org/*', production: false, source: 'mine' })
    expect(pickRule('https://app.example.org/', [yoda, mine])!.rule.id).toBe(mine.id)
    expect(isProduction('https://app.example.org/', [yoda, mine])).toBe(true)
  })
})
