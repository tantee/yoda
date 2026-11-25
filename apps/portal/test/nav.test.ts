import { describe, expect, it } from 'vitest'
import { homeFor, isStaffPath, navItemsFor } from '../app/utils/nav'

const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }

describe('navItemsFor', () => {
  it('staff nav', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key))
      .toEqual(['nav.chat', 'nav.todo', 'nav.discussions', 'nav.status', 'nav.projects'])
  })
  it('admin also gets people admin', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.admin.people')
  })
  it('AI budget page is admin only', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.admin.ai')
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key)).not.toContain('nav.admin.ai')
  })
  it('GitLab admin page is admin only', () => {
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.admin.gitlab')
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key)).not.toContain('nav.admin.gitlab')
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: true }).map(i => i.key)).not.toContain('nav.admin.gitlab')
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
  it('the to-do list is staff only but a single task is reachable by requesters', () => {
    expect(isStaffPath('/todo')).toBe(true)
    expect(isStaffPath('/todo/')).toBe(true)
    expect(isStaffPath('/todo/3f2c')).toBe(false)
  })
})

describe('discussion and agenda paths', () => {
  it('are staff only', () => {
    for (const p of ['/discussions', '/discussions/abc', '/agendas', '/agendas/abc', '/agendas/abc/present']) expect(isStaffPath(p)).toBe(true)
  })
})

describe('homeFor', () => {
  it('staff land on their to-do list, requesters on their requests', () => {
    expect(homeFor({ ...base, isStaff: true, isAdmin: false })).toBe('/todo')
    expect(homeFor({ ...base, isStaff: true, isAdmin: true })).toBe('/todo')
    expect(homeFor({ ...base, isStaff: false, isAdmin: false })).toBe('/requests')
  })
})
