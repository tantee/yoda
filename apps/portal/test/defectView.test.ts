import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bufferPlaylist, buildLine, commitUrl, orderAttachments, parseLog, safeHttpUrl } from '../app/utils/defectView'

describe('parseLog', () => {
  it('drops invalid entries and counts them, and caps at 500', () => {
    const good = { t: 1, level: 'error', message: 'boom' }
    const text = JSON.stringify([good, { t: 'x' }, { ...good, message: 'x'.repeat(2049) }, ...Array.from({ length: 600 }, (_, i) => ({ ...good, t: i }))])
    const r = parseLog(text, 'console')
    expect(r.entries).toHaveLength(500)
    expect(r.dropped).toBe(2 + 101)
  })
  it('a message with <script> stays a plain string', () => {
    const r = parseLog(JSON.stringify([{ t: 1, level: 'log', message: '<script>alert(1)</script>' }]), 'console')
    expect(r.entries[0]!.message).toBe('<script>alert(1)</script>')
    const card = readFileSync(new URL('../app/components/workItem/DefectCard.vue', import.meta.url), 'utf8')
    expect(card).not.toContain('v-html')
    expect(card).not.toContain('innerHTML')
  })
  it('network entries lose unknown keys (no headers or bodies)', () => {
    const r = parseLog(JSON.stringify([{ t: 1, method: 'GET', url: 'https://api.example.org/x', status: 500, durationMs: 12, failed: true, kind: 'fetch', headers: { a: 1 } }]), 'network')
    expect(r.entries[0]).not.toHaveProperty('headers')
  })
  it('bad JSON gives nothing', () => {
    expect(parseLog('not json', 'console')).toEqual({ entries: [], dropped: 0 })
    expect(parseLog('{"a":1}', 'network')).toEqual({ entries: [], dropped: 0 })
  })
})

describe('orderAttachments', () => {
  it('screenshots, then video and buffer, then logs', () => {
    const list = ['network', 'console', 'video', null, 'screenshot_full', 'buffer', 'screenshot'].map((role, i) => ({ role: role as never, fileName: `f${i}` }))
    expect(orderAttachments(list).map((a) => a.role)).toEqual(['screenshot', 'screenshot_full', 'video', 'buffer', 'console', 'network', null])
  })
})

describe('bufferPlaylist', () => {
  it('the buffer parts in order (buffer-1, buffer-2, … buffer-10), skipping removed ones and other files', () => {
    const a = (id: string, role: string, fileName: string, purgedAt: string | null = null) => ({ id, role: role as never, fileName, purgedAt })
    const list = [a('v', 'video', 'video.webm'), a('b10', 'buffer', 'buffer-10.webm'), a('b2', 'buffer', 'buffer-2.webm'), a('b1', 'buffer', 'buffer-1.webm'), a('b3', 'buffer', 'buffer-3.webm', '2026-11-01T00:00:00Z')]
    expect(bufferPlaylist(list).map((x) => x.id)).toEqual(['b1', 'b2', 'b10'])
    expect(bufferPlaylist([a('v', 'video', 'video.webm')])).toEqual([])
  })
  it('the card plays the parts back to back', () => {
    const card = readFileSync(new URL('../app/components/workItem/DefectCard.vue', import.meta.url), 'utf8')
    expect(card).toContain('bufferPlaylist')
    expect(card).toMatch(/@ended=/)
  })
})

describe('buildLine and links', () => {
  it('joins the parts and shortens the commit', () => {
    expect(buildLine({ repo: 'his/opd-web', branch: 'main', commit: 'a1b2c3d4e5f6a7b8c9d0', env: 'review', source: 'meta' })).toBe('his/opd-web · main · a1b2c3d4e5f6 · review')
    expect(buildLine({ commit: 'a1b2c3d', source: 'manual' })).toBe('a1b2c3d')
    expect(buildLine(null)).toBe('')
  })
  it('links a commit only for a linked repo and a hex sha', () => {
    const repos = [{ pathWithNamespace: 'his/opd-web', webUrl: 'https://gitlab.example.org/his/opd-web' }]
    expect(commitUrl({ repo: 'his/opd-web', commit: 'a1b2c3d', source: 'meta' }, repos)).toBe('https://gitlab.example.org/his/opd-web/-/commit/a1b2c3d')
    expect(commitUrl({ repo: 'other/x', commit: 'a1b2c3d', source: 'meta' }, repos)).toBeNull()
    expect(commitUrl({ repo: 'his/opd-web', commit: 'javascript:alert(1)', source: 'meta' }, repos)).toBeNull()
  })
  it('opens only http(s) page URLs', () => {
    expect(safeHttpUrl('https://app.example.org/opd?visit=1')).toBe('https://app.example.org/opd?visit=1')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('the Help page', () => {
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
  it('is in the staff rail and says nothing is masked', async () => {
    const { navItemsFor } = await import('../app/utils/nav')
    expect(navItemsFor({ id: 'x', username: 'u', displayName: 'U', email: null, isStaff: true, isAdmin: false }).map((i) => i.to)).toContain('/help')
    for (const f of ['th.json', 'en.json']) {
      const l = load(f)
      expect(typeof l.help.reporter.noMasking).toBe('string')
      expect(typeof l.defect.removed).toBe('string')
    }
    const page = readFileSync(new URL('../app/pages/help.vue', import.meta.url), 'utf8')
    expect(page).toContain('/extension/latest')
    expect(page).toContain('build:zip')
  })
})
