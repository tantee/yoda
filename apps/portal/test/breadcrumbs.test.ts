import { describe, expect, it } from 'vitest'
import { buildCrumbs, mobileCrumbs } from '../app/utils/breadcrumbs'
import { navGroupsFor } from '../app/utils/nav'

const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }
const staff = navGroupsFor({ ...base, isStaff: true, isAdmin: false })
const requester = navGroupsFor({ ...base, isStaff: false, isAdmin: false })
const t = (k: string) => `<${k}>`

describe('buildCrumbs', () => {
  it('a rail page: group, then the page (current, no link)', () => {
    expect(buildCrumbs({ path: '/todo', groups: staff }, t)).toEqual([
      { label: '<nav.group.mine>' },
      { label: '<nav.todo>' },
    ])
  })

  it('a group named like its page is not repeated', () => {
    const same = (k: string) => (k === 'nav.group.projects' ? 'P' : k === 'nav.projects' ? 'P' : k)
    expect(buildCrumbs({ path: '/projects/1', groups: staff, dynamic: [{ label: 'x' }] }, same)).toEqual([{ label: 'P', to: '/projects' }, { label: 'x' }])
  })

  it('the requester rail has no group crumb', () => {
    expect(buildCrumbs({ path: '/requests', groups: requester }, t)).toEqual([{ label: '<nav.requests>' }])
  })

  it('a sub-page links its rail page and appends the page-provided titles', () => {
    expect(buildCrumbs({ path: '/projects/p1', groups: staff, dynamic: [{ label: 'ระบบนัดหมาย' }] }, t)).toEqual([
      { label: '<nav.group.projects>' },
      { label: '<nav.projects>', to: '/projects' },
      { label: 'ระบบนัดหมาย' },
    ])
  })

  it('route meta crumbs replace the rail trail; the last crumb never links', () => {
    const meta = [{ key: 'nav.projects', to: '/projects' }]
    const dynamic = [{ label: 'ระบบนัดหมาย', to: '/projects/p1' }, { label: 'งาน', to: '/projects/p1' }, { label: 'แจ้งเตือนนัดผ่าน SMS', to: '/work-items/w1' }]
    expect(buildCrumbs({ path: '/work-items/w1', groups: staff, meta, dynamic }, t)).toEqual([
      { label: '<nav.projects>', to: '/projects' },
      { label: 'ระบบนัดหมาย', to: '/projects/p1' },
      { label: 'งาน', to: '/projects/p1' },
      { label: 'แจ้งเตือนนัดผ่าน SMS' },
    ])
  })

  it('meta crumbs may hold literal labels and empty ones are dropped', () => {
    expect(buildCrumbs({ path: '/x', groups: staff, meta: [{ key: 'shell.forbidden' }], dynamic: [{ label: '' }] }, t)).toEqual([
      { label: '<shell.forbidden>' },
    ])
  })

  it('an unknown path with nothing provided has no crumbs', () => {
    expect(buildCrumbs({ path: '/nowhere', groups: staff }, t)).toEqual([])
  })
})

describe('mobileCrumbs', () => {
  it('keeps the parent and the current item', () => {
    const crumbs = [{ label: 'a', to: '/a' }, { label: 'b', to: '/b' }, { label: 'c' }]
    expect(mobileCrumbs(crumbs)).toEqual([{ label: 'b', to: '/b' }, { label: 'c' }])
    expect(mobileCrumbs([{ label: 'c' }])).toEqual([{ label: 'c' }])
  })
  it('drops an unlinked group label when it would be the parent', () => {
    expect(mobileCrumbs([{ label: 'group' }, { label: 'page' }])).toEqual([{ label: 'page' }])
  })
})
