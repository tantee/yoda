import { E2E_TAB_TARGET } from './e2e-marker'

export { E2E_TAB_TARGET }

type Active = () => Promise<chrome.tabs.Tab>

/** The release rule: the popup acts on the active tab. */
export async function activeTarget(_search: string, queryActive: Active): Promise<number> {
  const tab = await queryActive()
  if (tab.id === undefined) throw new Error('no active tab')
  return tab.id
}

/** The e2e rule: `?tab=<id>` first (Playwright cannot click the toolbar button), else the active tab. */
export async function e2eTarget(search: string, queryActive: Active): Promise<number> {
  const id = Number(new URLSearchParams(search).get('tab'))
  if (Number.isInteger(id) && id > 0) {
    console.debug(E2E_TAB_TARGET)
    return id
  }
  return activeTarget(search, queryActive)
}

/** Chosen at build time: the release bundle contains only the active-tab rule. */
export const resolveTargetTab: (search: string, queryActive: Active) => Promise<number> = import.meta.env.VITE_TARGET === 'e2e' ? e2eTarget : activeTarget
