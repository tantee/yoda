import type { Person } from '@yoda/shared'

export type PeopleFilter = 'all' | 'staff' | 'requester' | 'admin'

/**
 * The people table (proposal §8.4): sorted by name in Thai collation, filtered by type and by a search over
 * name, username and skills (case-insensitive).
 */
export function peopleRows(list: readonly Person[], q: string, filter: PeopleFilter): Person[] {
  const needle = q.trim().toLocaleLowerCase('th')
  const collator = new Intl.Collator('th')
  return list
    .filter((p) => {
      if (filter === 'staff' && !p.isStaff) return false
      if (filter === 'requester' && p.isStaff) return false
      if (filter === 'admin' && !p.isAdmin) return false
      if (!needle) return true
      return [p.displayName, p.username, ...p.skills].some(s => s.toLocaleLowerCase('th').includes(needle))
    })
    .sort((a, b) => collator.compare(a.displayName, b.displayName) || a.username.localeCompare(b.username))
}
