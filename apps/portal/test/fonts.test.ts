import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url))
const text = (p: string) => read(p).toString('utf8')
const THAI_400 = 'ibm-plex-sans-thai-thai-400-normal.woff2'

describe('portal fonts (proposal §3.2)', () => {
  const css = text('../app/assets/fonts.css')
  it('loads 400, 500 and 600 only (700 is not used)', () => {
    expect(css).not.toMatch(/700/)
    for (const w of ['500', '600']) {
      expect(css).toContain(`@fontsource/ibm-plex-sans-thai/thai-${w}.css`)
      expect(css).toContain(`@fontsource/ibm-plex-sans/latin-${w}.css`)
    }
    expect(css).toContain('@fontsource/ibm-plex-sans/latin-400.css')
  })
  it('serves the Thai 400 file from a fixed path and preloads it', () => {
    expect(css).toContain(`url(/fonts/${THAI_400})`)
    expect(css).not.toContain('@fontsource/ibm-plex-sans-thai/thai-400.css')
    expect(text('../nuxt.config.ts')).toContain(`href: '/fonts/${THAI_400}'`)
  })
  it('keeps the public copy identical to the @fontsource file', () => {
    expect(read(`../public/fonts/${THAI_400}`).equals(read(`../node_modules/@fontsource/ibm-plex-sans-thai/files/${THAI_400}`))).toBe(true)
  })
})

const THEME = '../../../infra/keycloak/themes/yoda/login/'
const keys = (f: string) => text(`${THEME}messages/${f}`).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('=')[0]).sort()

describe('Keycloak login theme', () => {
  it('extends the base login theme in th and en', () => {
    const props = text(`${THEME}theme.properties`)
    expect(props).toMatch(/^parent=base$/m)
    expect(props).toMatch(/^locales=th,en$/m)
  })
  it('has the same message keys in th and en', () => {
    expect(keys('messages_th.properties')).toEqual(keys('messages_en.properties'))
    expect(keys('messages_th.properties')).toContain('yodaProductName')
  })
  it('names the product as the portal does', () => {
    expect(text(`${THEME}messages/messages_th.properties`)).toContain('yodaProductSub=พอร์ทัลงานฝ่าย IT')
  })
  it('escapes apostrophes for Keycloak message formatting', () => {
    for (const f of ['messages_th.properties', 'messages_en.properties']) {
      for (const line of text(`${THEME}messages/${f}`).split('\n').filter(l => !l.startsWith('#') && l.includes("'"))) expect(line.replaceAll("''", '')).not.toContain("'")
    }
  })
  it('bundles the portal font files with their licence', () => {
    for (const w of ['400', '500', '600']) {
      const thai = `ibm-plex-sans-thai-thai-${w}-normal.woff2`
      const latin = `ibm-plex-sans-latin-${w}-normal.woff2`
      expect(read(`${THEME}resources/fonts/${thai}`).equals(read(`../node_modules/@fontsource/ibm-plex-sans-thai/files/${thai}`))).toBe(true)
      expect(read(`${THEME}resources/fonts/${latin}`).equals(read(`../node_modules/@fontsource/ibm-plex-sans/files/${latin}`))).toBe(true)
    }
    expect(text(`${THEME}resources/fonts/OFL.txt`)).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })
})
