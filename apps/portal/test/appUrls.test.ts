import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validatePatternInput } from '../app/utils/appUrls'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

describe('validatePatternInput', () => {
  it.each([
    ['https://opd.example.org/*', 'ok'],
    ['https://*.review.example.org/*', 'ok'],
    ['http://localhost:3000/*', 'ok'],
    ['  https://opd.example.org/*  ', 'ok'],
    ['HTTPS://OPD.example.org/*', 'ok'],
    ['*://*/*', 'too_broad'],
    ['https://*/*', 'too_broad'],
    ['https://*:8443/*', 'too_broad'],
    ['', 'invalid'],
    ['opd.example.org', 'invalid'],
    ['https://opd.example.org', 'invalid'],
    ['<all_urls>', 'invalid'],
    ['ftp://opd.example.org/*', 'invalid'],
  ])('%s → %s', (input, expected) => {
    expect(validatePatternInput(input)).toBe(expected)
  })
})

describe('the application URLs tab', () => {
  const KEYS = [
    'projects.tabs.appUrls',
    'appUrls.title',
    'appUrls.intro',
    'appUrls.empty',
    'appUrls.pattern',
    'appUrls.patternHint',
    'appUrls.environment',
    'appUrls.production',
    'appUrls.productionHint',
    'appUrls.add',
    'appUrls.addTitle',
    'appUrls.remove',
    'appUrls.invalid',
    'appUrls.tooBroad',
    'appUrls.duplicate',
    'appUrls.removeTitle',
    'appUrls.removeText',
    'appUrls.removeProductionText',
    'chip.appUrl.production',
    'chip.appUrl.test',
  ]
  it.each(['th.json', 'en.json'])('%s has every key', (f) => {
    const l = load(f)
    for (const k of KEYS) expect(typeof lookup(l, k), k).toBe('string')
  })

  it('the tab is on the project page and renders text only', () => {
    const page = readFileSync(new URL('../app/pages/projects/[id].vue', import.meta.url), 'utf8')
    expect(page).toContain('<ProjectAppUrlsTab')
    const tab = readFileSync(new URL('../app/components/project/AppUrlsTab.vue', import.meta.url), 'utf8')
    expect(tab).not.toContain('v-html')
    expect(tab).toContain('StatusChip')
    expect(tab).toContain('AppDialog')
    expect(tab).toContain('ConfirmDialog')
    // Editing waits for a successful load, so a change never starts from an empty list.
    expect(tab).toMatch(/editable = computed\(\(\) => props.canManage && loaded.value && !loadError.value\)/)
  })
})
