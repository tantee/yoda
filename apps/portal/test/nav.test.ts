import { describe, expect, it } from 'vitest'
import {
  activeNavItem,
  bottomLabelKey,
  bottomNavFor,
  capCount,
  forbiddenFor,
  homeFor,
  initials,
  isNavActive,
  isStaffPath,
  navCount,
  navGroupsFor,
  navItemsFor,
  roleLineKeys,
} from '../app/utils/nav'

const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }
const staff = { ...base, isStaff: true, isAdmin: false }
const admin = { ...base, isStaff: true, isAdmin: true }
const requester = { ...base, isStaff: false, isAdmin: false }

describe('navItemsFor', () => {
  it('staff nav, in rail order (agendas join the nav)', () => {
    expect(navItemsFor(staff).map(i => i.key))
      .toEqual(['nav.todo', 'nav.chat', 'nav.projects', 'nav.status', 'nav.runners', 'nav.discussions', 'nav.agendas'])
  })
  it('admin also gets people admin', () => {
    expect(navItemsFor(admin).map(i => i.key)).toContain('nav.admin.people')
  })
  it('AI budget page is admin only', () => {
    expect(navItemsFor(admin).map(i => i.key)).toContain('nav.admin.ai')
    expect(navItemsFor(staff).map(i => i.key)).not.toContain('nav.admin.ai')
  })
  it('GitLab admin page is admin only', () => {
    expect(navItemsFor(admin).map(i => i.key)).toContain('nav.admin.gitlab')
    expect(navItemsFor(staff).map(i => i.key)).not.toContain('nav.admin.gitlab')
    expect(navItemsFor({ ...base, isStaff: false, isAdmin: true }).map(i => i.key)).not.toContain('nav.admin.gitlab')
  })
  it('requester nav has no staff areas', () => {
    expect(navItemsFor(requester).map(i => i.key)).toEqual(['nav.requests', 'nav.answers', 'nav.assistant'])
  })
})

describe('navGroupsFor', () => {
  it('groups the staff rail; the system group is admin only', () => {
    expect(navGroupsFor(staff).map(g => g.key)).toEqual(['nav.group.mine', 'nav.group.projects', 'nav.group.meetings'])
    expect(navGroupsFor(admin).map(g => g.key)).toEqual(['nav.group.mine', 'nav.group.projects', 'nav.group.meetings', 'nav.group.system'])
  })
  it('the requester rail is one group without a label', () => {
    const groups = navGroupsFor(requester)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBeNull()
  })
  it('badges: to-do, chat and discussions for staff; answers for requesters', () => {
    const badges = (me: typeof staff) => navItemsFor(me).filter(i => i.count).map(i => [i.key, i.count])
    expect(badges(staff)).toEqual([['nav.todo', 'todo'], ['nav.chat', 'chat'], ['nav.discussions', 'discussions']])
    expect(badges(requester)).toEqual([['nav.answers', 'answers']])
  })
})

describe('bottomNavFor', () => {
  it('staff: the 4 daily pages; requester: the 3 requester pages', () => {
    expect(bottomNavFor(staff).map(i => i.to)).toEqual(['/todo', '/chat', '/projects', '/status'])
    expect(bottomNavFor(admin).map(i => i.to)).toEqual(['/todo', '/chat', '/projects', '/status'])
    expect(bottomNavFor(requester).map(i => i.to)).toEqual(['/requests', '/answers', '/chat'])
  })
  it('uses short labels where the rail labels are long', () => {
    expect(bottomNavFor(staff).map(bottomLabelKey)).toEqual(['nav.todo', 'nav.chat', 'nav.projects', 'nav.short.status'])
    expect(bottomNavFor(requester).map(bottomLabelKey)).toEqual(['nav.requests', 'nav.answers', 'nav.short.assistant'])
  })
})

describe('isNavActive / activeNavItem', () => {
  it('matches the page and its sub-pages, not look-alike prefixes', () => {
    expect(isNavActive('/projects', '/projects')).toBe(true)
    expect(isNavActive('/projects', '/projects/abc')).toBe(true)
    expect(isNavActive('/projects', '/projectsx')).toBe(false)
  })
  it('picks the longest match', () => {
    expect(activeNavItem(navItemsFor(admin), '/admin/people')?.key).toBe('nav.admin.people')
    expect(activeNavItem(navItemsFor(staff), '/agendas/1/present')?.key).toBe('nav.agendas')
    expect(activeNavItem(navItemsFor(staff), '/work-items/1')).toBeNull()
  })
})

describe('counts', () => {
  it('caps at 99+ on the rail and 9+ on the bell; zero shows nothing', () => {
    expect(capCount(0)).toBeNull()
    expect(capCount(7)).toBe('7')
    expect(capCount(99)).toBe('99')
    expect(capCount(100)).toBe('99+')
    expect(capCount(9, 9)).toBe('9')
    expect(capCount(10, 9)).toBe('9+')
  })
  it('reads only the counts a rail item asks for', () => {
    const [todo] = navItemsFor(staff)
    expect(navCount(todo!, { todo: 16, chat: 3, discussions: 2 })).toBe('16')
    expect(navCount(todo!, null)).toBeNull()
    // A requester's counts never feed staff items.
    expect(navCount(todo!, { requests: 2, answers: 1 })).toBeNull()
    const projects = navItemsFor(staff).find(i => i.key === 'nav.projects')!
    expect(navCount(projects, { todo: 1, chat: 1, discussions: 1 })).toBeNull()
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

describe('forbiddenFor', () => {
  it('requesters on staff pages and non-admins on admin pages get the forbidden page', () => {
    expect(forbiddenFor(requester, '/projects')).toBe('staff')
    expect(forbiddenFor(requester, '/admin/people')).toBe('staff')
    expect(forbiddenFor(requester, '/todo/abc')).toBeNull()
    expect(forbiddenFor(requester, '/requests')).toBeNull()
    expect(forbiddenFor(staff, '/admin/ai')).toBe('admin')
    expect(forbiddenFor(staff, '/projects')).toBeNull()
    expect(forbiddenFor(admin, '/admin/ai')).toBeNull()
  })
})

describe('homeFor', () => {
  it('staff land on their to-do list, requesters on their requests', () => {
    expect(homeFor(staff)).toBe('/todo')
    expect(homeFor(admin)).toBe('/todo')
    expect(homeFor(requester)).toBe('/requests')
  })
})

describe('user menu', () => {
  it('role line', () => {
    expect(roleLineKeys(admin)).toEqual(['shell.role.staff', 'shell.role.admin'])
    expect(roleLineKeys(staff)).toEqual(['shell.role.staff'])
    expect(roleLineKeys(requester)).toEqual(['shell.role.requester'])
  })
  it('initials: first letters of the first two words; Thai skips leading vowels', () => {
    expect(initials('สมชาย ใจดี')).toBe('สจ')
    expect(initials('Somchai Jaidee')).toBe('SJ')
    expect(initials('เมย์')).toBe('ม')
    expect(initials('nurse1')).toBe('N')
    expect(initials('  ')).toBe('?')
  })
})
