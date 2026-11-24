import type { Me } from '@yoda/shared'

export type NavItem = { key: string; to: string; icon: string }

const item = (key: string, to: string, icon: string): NavItem => ({ key: `nav.${key}`, to, icon })

export function navItemsFor(me: Me): NavItem[] {
  if (!me.isStaff) {
    return [
      item('requests', '/requests', 'mdi-clipboard-text-outline'),
      item('chat', '/chat', 'mdi-chat-outline'),
      item('answers', '/answers', 'mdi-comment-question-outline'),
    ]
  }
  const items = [
    item('chat', '/chat', 'mdi-chat-outline'),
    item('todo', '/todo', 'mdi-checkbox-marked-outline'),
    item('discussions', '/discussions', 'mdi-forum-outline'),
    item('status', '/status', 'mdi-chart-timeline-variant'),
    item('projects', '/projects', 'mdi-folder-multiple-outline'),
  ]
  if (me.isAdmin) items.push(item('admin.people', '/admin/people', 'mdi-account-cog-outline'))
  return items
}

const STAFF_PREFIXES = ['/todo', '/discussions', '/status', '/projects', '/work-items', '/admin']

export function isStaffPath(path: string): boolean {
  // A single task page (/todo/<id>) is also reached by requesters, from notifications and "answers".
  if (/^\/todo\/[^/]+\/?$/.test(path)) return false
  return STAFF_PREFIXES.some(p => path === p || path.startsWith(p + '/'))
}

export function homeFor(me: Me): string {
  return me.isStaff ? '/chat' : '/requests'
}
