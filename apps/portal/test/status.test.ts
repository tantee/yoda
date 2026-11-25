import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EventType, HealthReasonCode, type HealthReason } from '@yoda/shared'
import { bangkokToday, healthColor, isOverdue, reasonLink, reasonText, spendPercent, usd } from '../app/utils/status'
import { isStaffPath, navItemsFor } from '../app/utils/nav'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const LOCALES = { th: load('th.json'), en: load('en.json') }
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

/** A small stand-in for vue-i18n: `a | b` plural forms (1 → first, otherwise last) and `{name}` interpolation. */
function translator(locale: 'th' | 'en') {
  return (key: string, named: Record<string, unknown> = {}, plural?: number): string => {
    const msg = lookup(LOCALES[locale], key)
    if (typeof msg !== 'string') return key
    const forms = msg.split(' | ')
    const form = plural === undefined || forms.length === 1 ? forms[0]! : plural === 1 ? forms[0]! : forms[forms.length - 1]!
    return form.replace(/\{(\w+)\}/g, (_, k: string) => String(named[k] ?? `{${k}}`))
  }
}

const reason = (code: HealthReason['code'], count: number): HealthReason => ({ code, count, sample: [] })
const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }

describe('healthColor', () => {
  it('colours each health', () => {
    expect(healthColor('on_track')).toBe('success')
    expect(healthColor('at_risk')).toBe('warning')
    expect(healthColor('blocked')).toBe('error')
  })
})

describe('reasonText', () => {
  it('has a sentence for every reason code in both languages', () => {
    for (const code of HealthReasonCode.options) {
      for (const locale of ['th', 'en'] as const) {
        expect(typeof lookup(LOCALES[locale], `status.reason.${code}`), `${locale} ${code}`).toBe('string')
        expect(reasonText(translator(locale), reason(code, 3))).toContain('3')
      }
    }
  })
  it('gives the count in English, singular and plural', () => {
    const t = translator('en')
    expect(reasonText(t, reason('overdue', 1))).toBe('1 work item is overdue')
    expect(reasonText(t, reason('overdue', 4))).toBe('4 work items are overdue')
    expect(reasonText(t, reason('stuck', 2))).toBe('2 work items have had no activity for 5 days or more')
  })
  it('gives the count in Thai', () => {
    const t = translator('th')
    expect(reasonText(t, reason('overdue', 4))).toBe('งานเลยกำหนด 4 รายการ')
    expect(reasonText(t, reason('urgent_discussion', 1))).toContain('1')
  })
  it('states the AI budget as a percent', () => {
    expect(reasonText(translator('en'), reason('ai_budget', 85))).toBe('85% of this month\'s AI budget used')
    expect(reasonText(translator('th'), reason('ai_budget', 85))).toContain('85%')
  })
})

describe('reasonLink', () => {
  it('links discussion reasons to the discussion and others to the work item', () => {
    expect(reasonLink('urgent_discussion', 'd1')).toBe('/discussions/d1')
    expect(reasonLink('high_discussion', 'd1')).toBe('/discussions/d1')
    for (const code of ['stuck', 'sync_failed', 'overdue'] as const) expect(reasonLink(code, 'w1')).toBe('/work-items/w1')
  })
})

describe('isOverdue', () => {
  it('today is not overdue, yesterday is, no date never is', () => {
    expect(isOverdue('2026-11-25', '2026-11-25')).toBe(false)
    expect(isOverdue('2026-11-24', '2026-11-25')).toBe(true)
    expect(isOverdue('2026-11-26', '2026-11-25')).toBe(false)
    expect(isOverdue(null, '2026-11-25')).toBe(false)
  })
})

describe('bangkokToday', () => {
  it('uses the Asia/Bangkok calendar date', () => {
    expect(bangkokToday(new Date('2026-11-24T16:59:00Z'))).toBe('2026-11-24')
    expect(bangkokToday(new Date('2026-11-24T17:00:00Z'))).toBe('2026-11-25')
  })
})

describe('spendPercent', () => {
  it('is the share of the budget, capped at 100; no budget is null', () => {
    expect(spendPercent(5, 20)).toBe(25)
    expect(spendPercent(30, 20)).toBe(100)
    expect(spendPercent(5, null)).toBeNull()
    expect(spendPercent(0, 0)).toBe(0)
    expect(spendPercent(1, 0)).toBe(100)
  })
})

describe('usd', () => {
  it('shows dollars with cents', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(12.345)).toBe('$12.35')
  })
})

describe('status nav', () => {
  it('is for staff only', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.to)).toContain('/status')
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: false }).map(i => i.to)).not.toContain('/status')
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: true }).map(i => i.to)).not.toContain('/status')
  })
  it('the status page is a staff path', () => {
    expect(isStaffPath('/status')).toBe(true)
    expect(isStaffPath('/status/')).toBe(true)
  })
})

describe('status i18n', () => {
  it('every key the status screens use exists in th and en', () => {
    const keys = [
      'status.title', 'status.totals.activeItems', 'status.totals.overdueItems', 'status.totals.openDiscussions', 'status.totals.aiSpend',
      'status.health.on_track', 'status.health.at_risk', 'status.health.blocked', 'status.board', 'status.people', 'status.recentEvents',
      'status.discussions', 'status.repos', 'status.weekly.title', 'status.weekly.draft', 'status.weekly.regenerate',
      'status.weekly.confirm', 'status.weekly.noAi', 'status.weekly.empty', 'status.weekly.notWritten', 'status.overdue', 'status.stuck',
      'workItems.targetDate', 'projects.tabs.status',
    ]
    for (const locale of ['th', 'en'] as const) for (const k of keys) expect(typeof lookup(LOCALES[locale], k), `${locale} ${k}`).toBe('string')
  })
})

describe('event labels', () => {
  it('every stored event type has a timeline label in th and en', () => {
    const liveOnly = ['discussion.responded', 'run.heartbeat', 'message.created', 'notification.created']
    for (const type of EventType.options.filter(x => !liveOnly.includes(x))) {
      for (const locale of ['th', 'en'] as const) expect(typeof lookup(LOCALES[locale], `events.${type}`), `${locale} ${type}`).toBe('string')
    }
  })
})
