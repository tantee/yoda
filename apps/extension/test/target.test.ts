import { describe, expect, it } from 'vitest'
import { activeTarget, E2E_TAB_TARGET, e2eTarget } from '../src/popup/target'

const active = async () => ({ id: 42 }) as chrome.tabs.Tab

describe('the popup target tab', () => {
  it('?tab is ignored by the release rule', async () => {
    expect(await activeTarget('?tab=7', active)).toBe(42)
  })
  it('the e2e rule honours ?tab (Playwright cannot click the toolbar)', async () => {
    expect(await e2eTarget('?tab=7', active)).toBe(7)
    expect(await e2eTarget('?tab=x', active)).toBe(42)
    expect(await e2eTarget('', active)).toBe(42)
    expect(E2E_TAB_TARGET).toBe('yoda-e2e-tab-target')
  })
})
