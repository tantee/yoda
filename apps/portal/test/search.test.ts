import { NotificationKind, SearchResultType } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { isLocalRoute, isSearchHotkey, NOTIFICATION_ICONS, SEARCH_ICONS, searchReady } from '../app/utils/search'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('search utils', () => {
  it('searches from 2 characters, trimmed', () => {
    expect(searchReady('')).toBe(false)
    expect(searchReady(' a ')).toBe(false)
    expect(searchReady(null)).toBe(false)
    expect(searchReady('นั')).toBe(true)
  })
  it('has an icon for every result and notification kind', () => {
    for (const t of SearchResultType.options) expect(SEARCH_ICONS[t]).toMatch(/^mdi-/)
    for (const k of NotificationKind.options) expect(NOTIFICATION_ICONS[k]).toMatch(/^mdi-/)
  })
  it('⌘K and Ctrl K open search; plain K or with other modifiers does not', () => {
    expect(isSearchHotkey(key('k', { metaKey: true }))).toBe(true)
    expect(isSearchHotkey(key('K', { ctrlKey: true }))).toBe(true)
    expect(isSearchHotkey(key('k'))).toBe(false)
    expect(isSearchHotkey(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false)
  })
  it('only same-site links are followed', () => {
    expect(isLocalRoute('/work-items/1')).toBe(true)
    expect(isLocalRoute('//evil.example.org')).toBe(false)
    expect(isLocalRoute('https://example.org')).toBe(false)
    expect(isLocalRoute(null)).toBe(false)
  })
})
