import type { Me, MeCounts } from '@yoda/shared'

/** Which `/me/counts` field badges a rail item. */
export type CountKey = 'todo' | 'chat' | 'discussions' | 'answers'
export type NavItem = { key: string; to: string; icon: string; count?: CountKey }
/** `key` is the group label's i18n key; null for the requester rail, which has no labels. */
export type NavGroup = { key: string | null; items: NavItem[] }

const item = (key: string, to: string, icon: string, count?: CountKey): NavItem =>
  count ? { key: `nav.${key}`, to, icon, count } : { key: `nav.${key}`, to, icon }

const TODO = item('todo', '/todo', 'mdi-checkbox-marked-circle-outline', 'todo')
const CHAT = item('chat', '/chat', 'mdi-message-text-outline', 'chat')
const PROJECTS = item('projects', '/projects', 'mdi-folder-outline')
const STATUS = item('status', '/status', 'mdi-chart-box-outline')
const REQUESTS = item('requests', '/requests', 'mdi-clipboard-text-outline')
const ANSWERS = item('answers', '/answers', 'mdi-comment-question-outline', 'answers')
const ASSISTANT = item('assistant', '/chat', 'mdi-message-text-outline')

/** The side rail (proposal §5.1, §5.2). */
export function navGroupsFor(me: Me): NavGroup[] {
  if (!me.isStaff) return [{ key: null, items: [REQUESTS, ANSWERS, ASSISTANT] }]
  const groups: NavGroup[] = [
    { key: 'nav.group.mine', items: [TODO, CHAT] },
    { key: 'nav.group.projects', items: [PROJECTS, STATUS, item('runners', '/runners', 'mdi-server-network-outline')] },
    {
      key: 'nav.group.meetings',
      items: [
        item('discussions', '/discussions', 'mdi-forum-outline', 'discussions'),
        item('agendas', '/agendas', 'mdi-calendar-text-outline'),
      ],
    },
  ]
  if (me.isAdmin) {
    groups.push({
      key: 'nav.group.system',
      items: [
        item('admin.people', '/admin/people', 'mdi-account-group-outline'),
        item('admin.ai', '/admin/ai', 'mdi-cash-multiple'),
        // One item for every system setting (D5); GitLab and the notification channels are its categories.
        item('admin.settings', '/admin/settings', 'mdi-cog-outline'),
      ],
    })
  }
  return groups
}

export function navItemsFor(me: Me): NavItem[] {
  return navGroupsFor(me).flatMap(g => g.items)
}

/** Mobile bottom navigation (proposal §4.3): the daily pages. */
export function bottomNavFor(me: Me): NavItem[] {
  if (!me.isStaff) return [REQUESTS, ANSWERS, ASSISTANT]
  return [TODO, CHAT, PROJECTS, STATUS]
}

export function isNavActive(to: string, path: string): boolean {
  return path === to || path.startsWith(to + '/')
}

/** The rail item the path belongs to (longest match), or null (e.g. a work item, reached from a project). */
export function activeNavItem(items: NavItem[], path: string): NavItem | null {
  let best: NavItem | null = null
  for (const i of items) if (isNavActive(i.to, path) && (!best || i.to.length > best.to.length)) best = i
  return best
}

/** A badge text: nothing for 0, capped at `cap`+ (rail 99+, bell 9+). */
export function capCount(n: number, cap = 99): string | null {
  if (!n || n < 0) return null
  return n > cap ? `${cap}+` : String(n)
}

export function navCount(i: NavItem, counts: MeCounts | null): string | null {
  if (!i.count || !counts || !(i.count in counts)) return null
  return capCount((counts as Record<string, number>)[i.count] ?? 0)
}

const STAFF_PREFIXES = ['/todo', '/discussions', '/agendas', '/status', '/projects', '/work-items', '/runners', '/admin']

export function isStaffPath(path: string): boolean {
  // A single task page (/todo/<id>) is also reached by requesters, from notifications and "answers".
  if (/^\/todo\/[^/]+\/?$/.test(path)) return false
  return STAFF_PREFIXES.some(p => path === p || path.startsWith(p + '/'))
}

/** Why `me` may not open `path` ('staff' pages, 'admin' pages), or null. The server enforces it either way. */
export function forbiddenFor(me: Me, path: string): 'staff' | 'admin' | null {
  if (!me.isStaff && isStaffPath(path)) return 'staff'
  if ((path === '/admin' || path.startsWith('/admin/')) && !me.isAdmin) return 'admin'
  return null
}

export function homeFor(me: Me): string {
  return me.isStaff ? '/todo' : '/requests'
}

/** The user menu's role line, as i18n keys joined with " · ". */
export function roleLineKeys(me: Me): string[] {
  if (!me.isStaff) return ['shell.role.requester']
  return me.isAdmin ? ['shell.role.staff', 'shell.role.admin'] : ['shell.role.staff']
}

// Thai leading vowels (เ แ โ ใ ไ) come before the consonant they are spoken after.
const LEADING_VOWEL = /^[เ-ไ]/

/** Avatar initials: the first letter of the first two words (Thai: the first consonant). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  const letters = words.map(w => [...w.replace(LEADING_VOWEL, '')][0] ?? '').join('').toUpperCase()
  return letters || '?'
}

/** The bottom bar uses short labels where the rail's are long. */
export function bottomLabelKey(i: NavItem): string {
  return i.key === 'nav.status' ? 'nav.short.status' : i.key === 'nav.assistant' ? 'nav.short.assistant' : i.key
}

/** The id in a work item deep link (`/work-items/<id>`, not its sub-pages), else null. */
export function workItemIdOf(path: string): string | null {
  return /^\/work-items\/([^/]+)\/?$/.exec(path)?.[1] ?? null
}
