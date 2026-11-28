import type { ExtensionGrant } from '@yoda/shared'

/** Not used for this long, a connected browser shows as idle. */
export const IDLE_DAYS = 7

export type GrantStatus = 'active' | 'idle' | 'revoked'

export function grantStatus(g: Pick<ExtensionGrant, 'revokedAt' | 'lastUsedAt' | 'createdAt'>, now: Date = new Date()): GrantStatus {
  if (g.revokedAt) return 'revoked'
  const last = new Date(g.lastUsedAt ?? g.createdAt).getTime()
  return now.getTime() - last >= IDLE_DAYS * 86_400_000 ? 'idle' : 'active'
}

const RANK: Record<GrantStatus, number> = { active: 0, idle: 1, revoked: 2 }
const lastUse = (g: ExtensionGrant) => new Date(g.lastUsedAt ?? g.createdAt).getTime()

/** Active first, then idle, then revoked; within each, the most recently used first. */
export function sortGrants(list: ExtensionGrant[], now: Date = new Date()): ExtensionGrant[] {
  return [...list].sort((a, b) => RANK[grantStatus(a, now)] - RANK[grantStatus(b, now)] || lastUse(b) - lastUse(a) || a.id.localeCompare(b.id))
}

/** The admin list's person filter: by name, any case; empty shows everyone. */
export function filterGrants(list: ExtensionGrant[], q: string): ExtensionGrant[] {
  const needle = q.trim().toLowerCase()
  return needle ? list.filter((g) => g.person.displayName.toLowerCase().includes(needle)) : list
}

/** The typed confirmation "Revoke all" asks for. */
export const REVOKE_ALL_WORD = 'REVOKE'
