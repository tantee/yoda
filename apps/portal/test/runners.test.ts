import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AccountType, AgentRunState, RunnerCapability, RunnerKind, RunnerMode } from '@yoda/shared'
import { heartbeatAgeMinutes, runnerStatus, sortRunners, waitingFor, withinHours } from '../app/utils/runners'
import { isStaffPath, navItemsFor } from '../app/utils/nav'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const LOCALES = { th: load('th.json'), en: load('en.json') }
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

describe('withinHours', () => {
  // 2026-11-25 is a Wednesday (day 3). Bangkok is UTC+7 all year.
  const bkk = (hhmm: string, day = '2026-11-25') => new Date(`${day}T${hhmm}:00+07:00`)
  const weekdays = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }

  it('no window means any time', () => {
    expect(withinHours(null, bkk('03:00'))).toBe(true)
  })
  it('uses Bangkok time, start inclusive and end exclusive', () => {
    expect(withinHours(weekdays, bkk('09:00'))).toBe(true)
    expect(withinHours(weekdays, bkk('17:59'))).toBe(true)
    expect(withinHours(weekdays, bkk('18:00'))).toBe(false)
    expect(withinHours(weekdays, bkk('08:59'))).toBe(false)
    // 02:30 UTC is 09:30 in Bangkok
    expect(withinHours(weekdays, new Date('2026-11-25T02:30:00Z'))).toBe(true)
  })
  it('the window never crosses midnight: late night is outside', () => {
    expect(withinHours({ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '23:00' }, bkk('23:30'))).toBe(false)
    expect(withinHours({ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '23:00' }, bkk('00:30'))).toBe(false)
  })
  it('a day not listed is outside, judged by the Bangkok date', () => {
    expect(withinHours(weekdays, bkk('10:00', '2026-11-28'))).toBe(false) // Saturday
    // Friday 20:00 UTC is Saturday 03:00 in Bangkok
    expect(withinHours({ days: [5], start: '00:00', end: '23:59' }, new Date('2026-11-27T20:00:00Z'))).toBe(false)
    expect(withinHours({ days: [6], start: '00:00', end: '23:59' }, new Date('2026-11-27T20:00:00Z'))).toBe(true)
  })
})

describe('heartbeatAgeMinutes', () => {
  it('whole minutes since the heartbeat, never negative', () => {
    const now = new Date('2026-11-25T10:00:00Z')
    expect(heartbeatAgeMinutes('2026-11-25T09:57:30Z', now)).toBe(2)
    expect(heartbeatAgeMinutes('2026-11-25T10:00:10Z', now)).toBe(0)
  })
})

describe('waitingFor', () => {
  const task = { executor: 'ai' as const, assigneeId: null, state: 'open' as const, aiStatus: null, capability: 'code-change' as const, run: null }
  it('open AI tasks a runner works wait for a runner', () => {
    for (const capability of RunnerCapability.options) expect(waitingFor({ ...task, capability })).toBe('runner')
  })
  it('a runner task whose last run ended waits for a runner again', () => {
    for (const state of ['failed', 'expired', 'released'] as const) {
      expect(waitingFor({ ...task, run: { state, runnerName: 'r', heartbeatAt: '2026-11-25T10:00:00Z', branch: null } })).toBe('runner')
    }
  })
  it('a running or parked run is not waiting (the run chip says so)', () => {
    for (const state of ['running', 'parked'] as const) {
      expect(waitingFor({ ...task, run: { state, runnerName: 'r', heartbeatAt: '2026-11-25T10:00:00Z', branch: null } })).toBeNull()
    }
  })
  it('a parked run whose question is cleared waits for a runner again', () => {
    const run = { state: 'parked' as const, runnerName: 'r', heartbeatAt: '2026-11-25T10:00:00Z', branch: null }
    expect(waitingFor({ ...task, run, parked: false })).toBe('runner')
    expect(waitingFor({ ...task, run, parked: true })).toBeNull()
  })
  it('draft-text waits for AI; AI status, assigned, human or closed tasks are not waiting', () => {
    expect(waitingFor({ ...task, capability: 'draft-text' })).toBe('ai')
    expect(waitingFor({ ...task, aiStatus: 'failed' })).toBeNull()
    expect(waitingFor({ ...task, assigneeId: crypto.randomUUID() })).toBeNull()
    expect(waitingFor({ ...task, executor: 'human', capability: null })).toBeNull()
    expect(waitingFor({ ...task, state: 'accepted' })).toBeNull()
  })
})

describe('runners nav', () => {
  const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }
  it('staff and admins get Runners; requesters do not', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key)).toContain('nav.runners')
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.runners')
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: false }).map(i => i.key)).not.toContain('nav.runners')
  })
  it('the runners page is staff only', () => {
    expect(isStaffPath('/runners')).toBe(true)
  })
})

describe('runner labels', () => {
  const keys = [
    'nav.runners',
    ...AgentRunState.options.map(s => `runners.state.${s}`),
    ...RunnerKind.options.map(s => `runners.kind.${s}`),
    ...RunnerMode.options.map(s => `runners.mode.${s}`),
    ...AccountType.options.map(s => `runners.accountType.${s}`),
    ...RunnerCapability.options.map(s => `runners.capability.${s}`),
    'runners.tokenOnce',
    'runners.settings.allowPersonalUnattended',
    'runners.settings.personalCaveat',
    'runners.settings.pauseAll',
    'workItems.waitingForRunner',
    'todo.waitingForRunner',
    ...['runner_failed', 'runner_released', 'runner_result', 'runner_revoked', 'mr_effect', 'task_unavailable', 'asked_human', 'lease_expired']
      .map(r => `events.reason.${r}`),
  ]
  it('exist in th and en', () => {
    for (const [name, l] of Object.entries(LOCALES)) {
      for (const k of keys) expect(typeof lookup(l, k), `${name}: ${k}`).toBe('string')
    }
  })
  it('th is the Thai text, not a copy of en', () => {
    expect(lookup(LOCALES.th, 'runners.tokenOnce')).not.toBe(lookup(LOCALES.en, 'runners.tokenOnce'))
    expect(lookup(LOCALES.th, 'runners.settings.personalCaveat')).not.toBe(lookup(LOCALES.en, 'runners.settings.personalCaveat'))
  })
})

describe('runnerStatus and sortRunners', () => {
  const r = (id: string, paused: boolean, revokedAt: string | null) => ({ id, paused, revokedAt })
  it('names the status: revoked over paused over active', () => {
    expect(runnerStatus(r('a', false, null))).toBe('active')
    expect(runnerStatus(r('a', true, null))).toBe('paused')
    expect(runnerStatus(r('a', true, '2026-11-01T00:00:00Z'))).toBe('revoked')
  })
  it('puts revoked runners last and keeps the rest in order', () => {
    const list = [r('x', false, '2026-11-01T00:00:00Z'), r('a', false, null), r('y', false, '2026-11-02T00:00:00Z'), r('b', true, null)]
    expect(sortRunners(list).map(x => x.id)).toEqual(['a', 'b', 'x', 'y'])
  })
})
