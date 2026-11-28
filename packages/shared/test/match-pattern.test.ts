import { describe, expect, it } from 'vitest'
import { matchesPattern, parseMatchPattern, patternSpecificity } from '../src/index.js'

describe('match patterns', () => {
  it.each([
    ['https://*.review.example.org/*', 'https://a.review.example.org/x', true],
    ['https://*.review.example.org/*', 'https://review.example.org/', true],
    ['https://*.review.example.org/*', 'https://b.a.review.example.org/x?q=1', true],
    ['https://*.review.example.org/*', 'http://a.review.example.org/', false],
    ['https://*.review.example.org/*', 'https://evilreview.example.org/', false],
    ['http://localhost:3000/*', 'http://localhost:3000/a', true],
    ['http://localhost:3000/*', 'http://localhost:5173/a', false],
    ['http://localhost:3000/*', 'http://localhost/a', false],
    ['http://localhost/*', 'http://localhost:5173/x', true],
    ['http://localhost/*', 'http://localhost/', true],
    ['*://app.example.org/*', 'http://app.example.org/', true],
    ['*://app.example.org/*', 'https://app.example.org/', true],
    ['*://app.example.org/*', 'ftp://app.example.org/', false],
    ['https://app.example.org/opd/*', 'https://app.example.org/opd/visit', true],
    ['https://app.example.org/opd/*', 'https://app.example.org/ipd/visit', false],
    ['https://app.example.org/opd*', 'https://app.example.org/opd?x=1', true],
    ['https://APP.example.org/*', 'https://app.example.org/', true],
    ['https://app.example.org/*', 'not a url', false],
  ])('%s against %s is %s', (p, url, want) => {
    expect(matchesPattern(p, url)).toBe(want)
  })

  it('parses the parts', () => {
    expect(parseMatchPattern('https://*.example.org/a/*')).toEqual({ scheme: 'https', host: '*.example.org', path: '/a/*' })
    expect(parseMatchPattern('http://localhost:3000/*')).toEqual({ scheme: 'http', host: 'localhost:3000', path: '/*' })
  })

  it.each(['<all_urls>', 'https://*example.org/*', 'https://exa*mple.org/*', 'ftp://example.org/*', 'https://example.org', 'example.org/*', 'https:///*', 'https://a.*.org/*', '', 'https://example.org:99999/*', 'https://exa mple.org/*'])(
    'refuses %s',
    (p) => {
      expect(parseMatchPattern(p)).toBeNull()
      expect(matchesPattern(p, 'https://example.org/')).toBe(false)
    },
  )

  it('ranks literal hosts above wildcards, longer hosts and paths higher', () => {
    const order = ['https://*.example.org/*', 'https://app.example.org/*', 'https://app.example.org/opd/*']
    const sorted = [...order].reverse().sort((a, b) => {
      const [ha, pa] = patternSpecificity(a)
      const [hb, pb] = patternSpecificity(b)
      return ha - hb || pa - pb
    })
    expect(sorted).toEqual(order)
    expect(patternSpecificity('https://a.review.example.org/*')[0]).toBeGreaterThan(patternSpecificity('https://*.review.example.org/*')[0])
    expect(patternSpecificity('https://*.review.example.org/*')[0]).toBeGreaterThan(patternSpecificity('https://*.example.org/*')[0])
    expect(patternSpecificity('https://*/*')[0]).toBeLessThan(patternSpecificity('https://*.org/*')[0])
  })
})
