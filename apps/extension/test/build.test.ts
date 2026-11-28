import { describe, expect, it } from 'vitest'
import { detectBuild, parseYodaBuild } from '../src/capture/build'
import { stripQuery } from '../src/capture/metadata'

describe('parseYodaBuild', () => {
  it('reads the ;-separated key=value pairs, percent-decoded', () => {
    expect(parseYodaBuild('repo=group/appt-web;branch=feature%3Bx;commit=3f9c2e1;env=uat')).toEqual({ repo: 'group/appt-web', branch: 'feature;x', commit: '3f9c2e1', env: 'uat' })
    expect(parseYodaBuild('repo=a;built=2026-11-27T10:02:00Z')).toEqual({ repo: 'a', builtAt: '2026-11-27T10:02:00Z' })
  })
  it('drops empty values, unknown keys and junk; caps each value at 200 characters', () => {
    expect(parseYodaBuild('repo=;branch= ;commit=abc;evil=1;;garbage;=x')).toEqual({ commit: 'abc' })
    expect(parseYodaBuild('commit=%E0%A4%A')).toEqual({})
    expect(parseYodaBuild(`repo=${'x'.repeat(300)}`).repo).toHaveLength(200)
    expect(parseYodaBuild('')).toEqual({})
    // Inherited names are not keys.
    expect(parseYodaBuild('constructor=x;toString=y;__proto__=z')).toEqual({})
  })
})

describe('detectBuild', () => {
  const gitlab = { repo: 'g/app', ref: 'main', sha: 'f'.repeat(40), deployedAt: '2026-11-27T00:00:00Z' }
  it('takes meta, then well-known, then the header, then GitLab, and says which', () => {
    expect(detectBuild({ meta: 'commit=aaa', wellKnown: { commit: 'bbb' }, headers: ['commit=ccc'], gitlab })).toEqual({ commit: 'aaa', source: 'meta' })
    expect(detectBuild({ meta: null, wellKnown: { commit: 'bbb', repo: 'g/x', junk: 1 }, headers: ['commit=ccc'], gitlab })).toEqual({ commit: 'bbb', repo: 'g/x', source: 'well-known' })
    expect(detectBuild({ meta: null, wellKnown: null, headers: ['', 'commit=ccc'], gitlab })).toEqual({ commit: 'ccc', source: 'header' })
    expect(detectBuild({ meta: null, wellKnown: null, headers: [], gitlab })).toEqual({ repo: 'g/app', branch: 'main', commit: 'f'.repeat(40), builtAt: '2026-11-27T00:00:00Z', source: 'gitlab' })
    expect(detectBuild({ meta: null, wellKnown: null, headers: [], gitlab: null })).toBeNull()
  })
  it('a meta tag with nothing usable falls through to the next source', () => {
    expect(detectBuild({ meta: 'junk', wellKnown: 'not an object', headers: ['commit=ccc'], gitlab: null })).toEqual({ commit: 'ccc', source: 'header' })
  })
})

describe('stripQuery', () => {
  it('drops the query and keeps the hash', () => {
    expect(stripQuery('https://app.example.org/opd?visit=12&hn=1#/queue')).toBe('https://app.example.org/opd#/queue')
    expect(stripQuery('https://app.example.org/opd')).toBe('https://app.example.org/opd')
    expect(stripQuery('not a url')).toBe('not a url')
  })
})
