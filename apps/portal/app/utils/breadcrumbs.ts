import { activeNavItem, type NavGroup } from './nav'

/** A breadcrumb as rendered: the last one is the current page and never links. */
export type Crumb = { label: string; to?: string }
/** A route-meta crumb (`definePageMeta({ crumbs })`): an i18n key, optionally linked. */
export type MetaCrumb = { key: string; to?: string }

export type CrumbInput = {
  path: string
  groups: NavGroup[]
  /** From route meta: replaces the rail-derived trail when set. */
  meta?: MetaCrumb[]
  /** From the page (`useBreadcrumb`): titles of dynamic routes, appended. */
  dynamic?: Crumb[]
}

function railTrail(path: string, groups: NavGroup[], t: (key: string) => string): Crumb[] {
  const item = activeNavItem(groups.flatMap(g => g.items), path)
  if (!item) return []
  const group = groups.find(g => g.items.includes(item))
  // A group named like its page (โครงการ › โครงการ) is not repeated.
  const trail: Crumb[] = group?.key && t(group.key) !== t(item.key) ? [{ label: t(group.key) }] : []
  trail.push({ label: t(item.key), to: item.to })
  return trail
}

/**
 * The top bar's trail (proposal §5.3): route meta crumbs, or else the rail group and page the path belongs to;
 * then the titles the page provides. Group labels never link; the last crumb is the current page.
 */
export function buildCrumbs(input: CrumbInput, t: (key: string) => string): Crumb[] {
  const head = input.meta ? input.meta.map(m => ({ label: t(m.key), to: m.to })) : railTrail(input.path, input.groups, t)
  const all = [...head, ...(input.dynamic ?? [])].filter(c => c.label)
  return all.map((c, i) => (i === all.length - 1 || !c.to ? { label: c.label } : { label: c.label, to: c.to }))
}

/** Mobile: the parent (when it links somewhere) and the current item. */
export function mobileCrumbs(crumbs: Crumb[]): Crumb[] {
  if (crumbs.length < 2) return crumbs
  const parent = crumbs[crumbs.length - 2]!
  const current = crumbs[crumbs.length - 1]!
  return parent.to ? [parent, current] : [current]
}

declare module '#app' {
  interface PageMeta {
    /** Breadcrumb trail before the page's own titles; see `buildCrumbs`. */
    crumbs?: MetaCrumb[]
  }
}
