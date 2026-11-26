import { describe, expect, it } from 'vitest'
import { loginLocale } from '../app/utils/loginLocale'

describe('loginLocale', () => {
  it('signs in in Thai unless English was chosen in the portal', () => {
    expect(loginLocale('')).toBe('th')
    expect(loginLocale('a=1; yoda_locale=th')).toBe('th')
    expect(loginLocale('yoda_locale=en')).toBe('en')
    expect(loginLocale('x=1; yoda_locale=en; y=2')).toBe('en')
  })
  it('ignores look-alike cookies and other values', () => {
    expect(loginLocale('not_yoda_locale=en')).toBe('th')
    expect(loginLocale('yoda_locale=english')).toBe('th')
  })
})
