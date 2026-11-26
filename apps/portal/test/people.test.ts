import { describe, expect, it } from 'vitest'
import type { Person } from '@yoda/shared'
import { peopleRows } from '../app/utils/people'

const p = (displayName: string, over: Partial<Person> = {}): Person => ({
  id: crypto.randomUUID(), username: displayName.toLowerCase(), displayName, email: null, isStaff: true, isAdmin: false, skills: [], staffOverride: null, ...over,
})

describe('peopleRows', () => {
  const list = [
    p('สมชาย ใจดี', { isAdmin: true, skills: ['PM'] }),
    p('กนกวรรณ ทองดี', { skills: ['Vue', 'HIS'] }),
    p('nurse1', { isStaff: false }),
    p('ธนกร พึ่งบุญ', { username: 'dev1' }),
  ]
  it('sorts by name in Thai order', () => {
    expect(peopleRows(list, '', 'all').map(x => x.displayName)).toEqual(['กนกวรรณ ทองดี', 'ธนกร พึ่งบุญ', 'สมชาย ใจดี', 'nurse1'])
  })
  it('filters by type', () => {
    expect(peopleRows(list, '', 'requester').map(x => x.displayName)).toEqual(['nurse1'])
    expect(peopleRows(list, '', 'staff')).toHaveLength(3)
    expect(peopleRows(list, '', 'admin').map(x => x.displayName)).toEqual(['สมชาย ใจดี'])
  })
  it('searches name, username and skills', () => {
    expect(peopleRows(list, 'ทอง', 'all').map(x => x.displayName)).toEqual(['กนกวรรณ ทองดี'])
    expect(peopleRows(list, 'DEV1', 'all').map(x => x.displayName)).toEqual(['ธนกร พึ่งบุญ'])
    expect(peopleRows(list, 'vue', 'all').map(x => x.displayName)).toEqual(['กนกวรรณ ทองดี'])
    expect(peopleRows(list, 'vue', 'requester')).toEqual([])
  })
})
