import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function flatten(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}
function messages(o: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? messages(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)] as [string, string]],
  )
}
const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))

describe('i18n parity', () => {
  it('th and en have identical keys', () => {
    expect(flatten(load('th.json')).sort()).toEqual(flatten(load('en.json')).sort())
  })

  // `nuxt build` (unplugin-vue-i18n) refuses a message that looks like HTML, so a `<placeholder>` breaks the image build.
  it.each(['th.json', 'en.json'])('%s has no HTML-like message', (f) => {
    expect(messages(load(f)).filter(([, m]) => /<[a-zA-Z/!]/.test(m)).map(([k]) => k)).toEqual([])
  })
})
