import type { Crumb } from '~/utils/breadcrumbs'

type PageCrumbs = { path: string; crumbs: Crumb[] }

/** Shared with the top bar: the titles the current page added, keyed by the route path they belong to. */
export function usePageCrumbs() {
  return useState<PageCrumbs | null>('pageCrumbs', () => null)
}

/**
 * Adds the current page's dynamic titles to the top bar's breadcrumbs (after the route-meta or rail trail):
 *
 *   useBreadcrumb(() => item.value ? [{ label: item.value.projectName, to: `/projects/${item.value.projectId}` }, { label: item.value.title }] : [])
 *
 * Reactive; cleared when the page unmounts (only if the next page has not already set its own).
 */
export function useBreadcrumb(source: MaybeRefOrGetter<Crumb[]>): void {
  const state = usePageCrumbs()
  const path = useRoute().path
  watchEffect(() => {
    state.value = { path, crumbs: toValue(source) }
  })
  onBeforeUnmount(() => {
    if (state.value?.path === path) state.value = null
  })
}
