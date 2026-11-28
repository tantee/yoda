import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { backendBuilds, resourceFailures, sanitizeEntries } from '../src/capture/logs'

const con = (i: number, message = `m${i}`) => ({ kind: 'console', t: i, level: 'error', message })
const net = (i: number, o: Record<string, unknown> = {}) => ({ kind: 'network', t: i, method: 'GET', url: `https://api.example.org/${i}`, status: 500, durationMs: 3, failed: true, kind2: 'x', type: 'fetch', ...o })

describe('sanitizeEntries', () => {
  it('10 000 entries keep the newest 500', () => {
    const r = sanitizeEntries(Array.from({ length: 10_000 }, (_, i) => con(i)))
    expect(r.console).toHaveLength(500)
    expect(r.console[0]!.t).toBe(9500)
    expect(r.console.at(-1)!.t).toBe(9999)
  })

  it('a 1 MB message is cut to 2048 characters', () => {
    const r = sanitizeEntries([con(1, 'x'.repeat(1024 * 1024))])
    expect(r.console[0]!.message).toHaveLength(2048)
  })

  it('non-schema entries are dropped and counted', () => {
    const r = sanitizeEntries([con(1), { kind: 'console', t: 'x' }, null, 'str', { kind: 'evil' }, net(2)])
    expect(r.console).toHaveLength(1)
    expect(r.network).toHaveLength(1)
    expect(r.dropped).toBe(4)
  })

  it('network entries keep only the schema fields (never headers or bodies)', () => {
    const r = sanitizeEntries([net(1, { headers: { authorization: 'x' }, body: 'secret' })])
    expect(r.network[0]).not.toHaveProperty('headers')
    expect(r.network[0]).not.toHaveProperty('body')
    expect(r.network[0]!.kind).toBe('fetch')
  })

  it('HTML in a message stays text (no v-html anywhere in src/)', () => {
    const r = sanitizeEntries([con(1, '<img src=x onerror=alert(1)>')])
    expect(r.console[0]!.message).toBe('<img src=x onerror=alert(1)>')
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
    for (const f of walk(src).filter((f) => /\.(vue|ts)$/.test(f))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/v-html|innerHTML\s*=/)
  })
})

describe('resourceFailures and backendBuilds', () => {
  const entry = (o: Partial<PerformanceResourceTiming & { responseStatus: number }>) => ({ name: 'https://app.example.org/a.js', startTime: 10, duration: 5, initiatorType: 'script', transferSize: 100, responseStatus: 200, ...o }) as PerformanceResourceTiming
  it('picks a 500 and a blocked same-origin load', () => {
    const r = resourceFailures([entry({ responseStatus: 500, name: 'https://app.example.org/api.json' }), entry({ responseStatus: 0, transferSize: 0, name: 'https://app.example.org/blocked.js' }), entry({ responseStatus: 0, transferSize: 0, name: 'https://cdn.example.net/x.js' }), entry({})], 'https://app.example.org')
    expect(r.map((e) => [e.url, e.status, e.failed, e.kind])).toEqual([
      ['https://app.example.org/api.json', 500, true, 'resource'],
      ['https://app.example.org/blocked.js', null, true, 'resource'],
    ])
  })
  it('dedupes back-end builds per origin, at most 10', () => {
    const list = [
      { t: 1, method: 'GET', url: 'https://api.example.org/a', status: 200, durationMs: 1, failed: false, kind: 'fetch' as const, yodaBuild: 'repo=his/api;commit=aaa' },
      { t: 2, method: 'GET', url: 'https://api.example.org/b', status: 200, durationMs: 1, failed: false, kind: 'fetch' as const, yodaBuild: 'repo=his/api;commit=bbb' },
      ...Array.from({ length: 12 }, (_, i) => ({ t: 3 + i, method: 'GET', url: `https://s${i}.example.org/`, status: 200, durationMs: 1, failed: false, kind: 'xhr' as const, yodaBuild: `commit=c${i}` })),
    ]
    const b = backendBuilds(list)
    expect(b).toHaveLength(10)
    // The 10 seen most recently; api.example.org was seen first, so it is not among them.
    expect(b.map((x) => x.origin)).not.toContain('https://api.example.org')
    expect(b.at(-1)).toEqual({ origin: 'https://s11.example.org', commit: 'c11' })
    expect(backendBuilds(list.slice(0, 2))).toEqual([{ origin: 'https://api.example.org', repo: 'his/api', commit: 'bbb' }])
  })
})
