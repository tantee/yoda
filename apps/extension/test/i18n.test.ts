import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../src/i18n/${f}`, import.meta.url), 'utf8')) as Record<string, unknown>
function flatten(o: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)] as [string, string]]))
}

describe('extension strings', () => {
  it('th and en have identical keys and no HTML-like messages', () => {
    const th = flatten(load('th.json'))
    const en = flatten(load('en.json'))
    expect(th.map(([k]) => k).sort()).toEqual(en.map(([k]) => k).sort())
    for (const [k, m] of [...th, ...en]) expect(/<[a-zA-Z/!]/.test(m), k).toBe(false)
  })

  it('_locales name the extension in Thai and English', () => {
    const msg = (l: string) => JSON.parse(readFileSync(new URL(`../public/_locales/${l}/messages.json`, import.meta.url), 'utf8')) as Record<string, { message: string }>
    expect(msg('th').extName!.message).toBe('Yoda แจ้งปัญหา')
    expect(msg('en').extName!.message).toBe('Yoda Reporter')
    expect(Object.keys(msg('th')).sort()).toEqual(Object.keys(msg('en')).sort())
  })
})
