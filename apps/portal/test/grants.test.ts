import { readFileSync } from 'node:fs'
import type { ExtensionGrant } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { filterGrants, grantStatus, revokeAllTyped, sortGrants } from '../app/utils/grants'
import { navItemsFor } from '../app/utils/nav'

const NOW = new Date('2026-11-28T12:00:00Z')
let n = 0
const grant = (o: Partial<ExtensionGrant> = {}): ExtensionGrant => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  extensionId: 'hcnhkfonaflhcknbhcphbfgpdfmgmibm',
  browserLabel: 'Chrome 131 Windows',
  createdAt: '2026-11-01T00:00:00Z',
  lastUsedAt: '2026-11-28T11:00:00Z',
  lastIp: '10.0.0.1',
  revokedAt: null,
  revokeReason: null,
  person: { id: '00000000-0000-4000-8000-000000000999', displayName: 'คุณคิวซี' },
  ...o,
})

describe('grantStatus', () => {
  it('active, idle after 7 days without use, revoked', () => {
    expect(grantStatus(grant(), NOW)).toBe('active')
    expect(grantStatus(grant({ lastUsedAt: '2026-11-21T12:00:01Z' }), NOW)).toBe('active')
    expect(grantStatus(grant({ lastUsedAt: '2026-11-21T12:00:00Z' }), NOW)).toBe('idle')
    expect(grantStatus(grant({ lastUsedAt: null, createdAt: '2026-11-01T00:00:00Z' }), NOW)).toBe('idle')
    expect(grantStatus(grant({ revokedAt: '2026-11-27T00:00:00Z', revokeReason: 'user' }), NOW)).toBe('revoked')
  })
})

describe('sortGrants', () => {
  it('active first, then by last use', () => {
    const old = grant({ lastUsedAt: '2026-11-28T09:00:00Z' })
    const recent = grant({ lastUsedAt: '2026-11-28T11:30:00Z' })
    const idle = grant({ lastUsedAt: '2026-10-01T00:00:00Z' })
    const revoked = grant({ revokedAt: '2026-11-28T11:59:00Z', lastUsedAt: '2026-11-28T11:59:00Z' })
    expect(sortGrants([revoked, idle, old, recent], NOW).map((g) => g.id)).toEqual([recent.id, old.id, idle.id, revoked.id])
  })
})

describe('revokeAllTyped', () => {
  it('needs the word, in any case', () => {
    expect(revokeAllTyped(' revoke ')).toBe(true)
    expect(revokeAllTyped('REVOKE')).toBe(true)
    expect(revokeAllTyped('REVOK')).toBe(false)
  })
})

describe('filterGrants', () => {
  it('filters by person name', () => {
    const a = grant({ person: { id: 'a', displayName: 'Somchai' } })
    const b = grant({ person: { id: 'b', displayName: 'คุณคิวซี' } })
    expect(filterGrants([a, b], 'som')).toEqual([a])
    expect(filterGrants([a, b], ' ')).toEqual([a, b])
  })
})

describe('navigation and strings', () => {
  const me = (isAdmin: boolean) => ({ id: 'x', username: 'u', displayName: 'U', email: null, isStaff: true, isAdmin })
  it('admins get Connected browsers in the rail; staff do not', () => {
    expect(navItemsFor(me(true)).map((i) => i.to)).toContain('/admin/browsers')
    expect(navItemsFor(me(false)).map((i) => i.to)).not.toContain('/admin/browsers')
  })

  const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
  const lookup = (o: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)
  it.each(['th.json', 'en.json'])('%s has the keys', (f) => {
    const l = load(f)
    const keys = [
      'nav.admin.browsers',
      'shell.connectedBrowsers',
      'grants.title', 'grants.adminTitle', 'grants.intro', 'grants.adminIntro', 'grants.empty', 'grants.created', 'grants.lastUsed', 'grants.never',
      'grants.revoke', 'grants.revokeTitle', 'grants.revokeText', 'grants.revokeAll', 'grants.revokeAllTitle', 'grants.revokeAllText',
      'grants.revokeAllType', 'grants.revokedAll', 'grants.filterEmpty', 'grants.clearFilters', 'grants.filterPerson', 'grants.activeOnly', 'grants.revokedReason',
      'grants.reason.user', 'grants.reason.admin', 'grants.reason.admin_all', 'grants.reason.reuse_detected', 'grants.reason.extension_not_allowed', 'grants.reason.not_staff',
      'chip.grant.active', 'chip.grant.idle', 'chip.grant.revoked',
    ]
    for (const k of keys) expect(typeof lookup(l, k), k).toBe('string')
  })

  it('the user menu links to Connected browsers', () => {
    const menu = readFileSync(new URL('../app/components/UserMenu.vue', import.meta.url), 'utf8')
    expect(menu).toContain('data-testid="menu-connected-browsers"')
    expect(menu).toContain('to="/settings/browsers"')
  })
})
