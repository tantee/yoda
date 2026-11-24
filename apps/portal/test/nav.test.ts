import { describe, expect, it } from 'vitest'
import { isStaffPath, navItemsFor } from '../app/utils/nav'

const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }

describe('navItemsFor', () => {
  it('staff nav', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key))
      .toEqual(['nav.chat', 'nav.todo', 'nav.discussions', 'nav.status', 'nav.projects'])
  })
  it('admin also gets people admin', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.admin.people')
  })
  it('requester nav has no staff areas', () => {
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: false }).map(i => i.key))
      .toEqual(['nav.requests', 'nav.chat', 'nav.answers'])
  })
})

describe('isStaffPath', () => {
  it('work items are staff only', () => {
    expect(isStaffPath('/work-items/abc')).toBe(true)
  })
})
