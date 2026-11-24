import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function flatten(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}
const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))

describe('i18n parity', () => {
  it('th and en have identical keys', () => {
    expect(flatten(load('th.json')).sort()).toEqual(flatten(load('en.json')).sort())
  })
})
