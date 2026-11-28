import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectScope, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AppMark from '../app/components/AppMark.vue'
import EmptyState from '../app/components/EmptyState.vue'
import SkeletonDetail from '../app/components/SkeletonDetail.vue'
import SkeletonList from '../app/components/SkeletonList.vue'
import { useFunMode } from '../app/composables/useFunMode'
import { useKonami } from '../app/composables/useKonami'
import { KONAMI, WISE_COUNTS, ignoreKey, keyCode, konamiStep, stableHash, wiseKey, wiseLine, type WiseKind } from '../app/utils/funMode'
import { resetStates, testRoute } from './support/imports'
import { render } from './support/render'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const locale = (l: string) => JSON.parse(readFileSync(join(root, `i18n/locales/${l}.json`), 'utf8'))
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' || f.startsWith('.') ? [] : files(p, ext)
    return ext.test(f) ? [p] : []
  })
const setFun = (on: boolean | null) => {
  useFunMode().state.value = on
}

beforeEach(() => {
  resetStates()
  testRoute.path = '/todo'
})

describe('wise lines', () => {
  it('rotate deterministically by page', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'))
    expect(wiseKey('empty', '/todo')).toBe(wiseKey('empty', '/todo'))
    const keys = new Set(['/todo', '/projects', '/chat', '/requests', '/answers', '/status', '/runners', '/agendas'].map((p) => wiseKey('empty', p)))
    expect(keys.size).toBeGreaterThan(2)
    for (const k of keys) expect(k).toMatch(/^fun\.empty\.\d$/)
  })
  it('are nothing when fun mode is off', () => {
    const t = vi.fn((k: string) => k)
    expect(wiseLine(false, 'empty', '/todo', t)).toBeUndefined()
    expect(t).not.toHaveBeenCalled()
    expect(wiseLine(true, 'error', '/x', t)).toMatch(/^fun\.error\.\d$/)
  })
  it('exist in th and en for every index, original and short', () => {
    for (const l of ['th', 'en']) {
      const fun = locale(l).fun
      for (const kind of Object.keys(WISE_COUNTS) as WiseKind[]) {
        expect(fun[kind]).toHaveLength(WISE_COUNTS[kind])
        for (const line of fun[kind] as string[]) {
          expect(line.length).toBeLessThan(60)
          expect(line).not.toMatch(/[{}@|$]/) // vue-i18n syntax characters
        }
      }
      expect(fun.konami).toBeTruthy()
    }
    expect(locale('en').fun.konami).toBe('May the source be with you')
    expect(locale('th').fun.konami).toBe('ขอให้ซอร์สโค้ดจงสถิตอยู่กับท่าน')
  })
})

describe('fun mode off: nothing from the gimmick renders', () => {
  it('unknown counts as off', () => {
    expect(useFunMode().enabled.value).toBe(false)
  })
  it('EmptyState: a line only in fun mode and only when the page opts in; explicit secondary always', async () => {
    setFun(false)
    expect(await render(EmptyState, { title: 'x', wisdom: 'empty' })).not.toContain('empty-secondary')
    expect(await render(EmptyState, { title: 'x', wisdom: 'notFound' })).not.toContain('fun.')
    expect(await render(EmptyState, { title: 'x', secondary: 'given' })).toContain('given')
    setFun(true)
    expect(await render(EmptyState, { title: 'x' })).not.toContain('empty-secondary')
    expect(await render(EmptyState, { title: 'x', wisdom: 'empty' })).toContain(wiseKey('empty', '/todo'))
    expect(await render(EmptyState, { title: 'x', wisdom: 'notFound' })).toContain(wiseKey('notFound', '/todo'))
    expect(await render(EmptyState, { title: 'x', wisdom: 'error' })).toContain(wiseKey('error', '/todo'))
    expect(await render(EmptyState, { title: 'x', wisdom: false })).not.toContain('empty-secondary')
  })
  it('skeletons: a caption only in fun mode, never when quiet', async () => {
    setFun(false)
    expect(await render(SkeletonList)).not.toContain('skeleton-caption')
    expect(await render(SkeletonDetail)).not.toContain('skeleton-caption')
    setFun(true)
    expect(await render(SkeletonList)).toContain(wiseKey('loading', '/todo'))
    expect(await render(SkeletonDetail)).toContain('skeleton-caption')
    expect(await render(SkeletonList, { quiet: true })).not.toContain('skeleton-caption')
  })
  it('AppMark: static mark with no star or animation class when off', async () => {
    setFun(false)
    const off = await render(AppMark)
    expect(off).toContain('data-fun="off"')
    expect(off).not.toContain('app-mark--fun')
    expect(off).not.toContain('app-mark__star')
    setFun(true)
    const on = await render(AppMark)
    expect(on).toContain('app-mark--fun')
    expect(on).toContain('app-mark__star')
    expect(await render(AppMark, { fun: false })).not.toContain('app-mark__star')
  })
})

describe('Konami code', () => {
  const press = (codes: readonly string[], start: string[] = []) => {
    let buffer = start
    let matched = 0
    for (const code of codes) {
      const s = konamiStep(buffer, code)
      buffer = s.buffer
      if (s.matched) matched++
    }
    return matched
  }
  it('matches the full sequence, also after extra presses, and resets', () => {
    expect(press(KONAMI)).toBe(1)
    expect(press(['ArrowUp', 'ArrowUp', ...KONAMI])).toBe(1)
    expect(press([...KONAMI, ...KONAMI])).toBe(2)
    expect(press(KONAMI.slice(0, 9))).toBe(0)
    expect(press(['KeyA', ...KONAMI.slice(1)])).toBe(0)
  })
  it('reads B and A by position or letter; ignores fields and shortcuts', () => {
    expect(keyCode({ code: 'KeyB', key: 'ิ' })).toBe('KeyB')
    expect(keyCode({ key: 'A' })).toBe('KeyA')
    expect(ignoreKey({ target: { tagName: 'INPUT' } })).toBe(true)
    expect(ignoreKey({ target: { tagName: 'TEXTAREA' } })).toBe(true)
    expect(ignoreKey({ target: { tagName: 'DIV', isContentEditable: true } })).toBe(true)
    expect(ignoreKey({ target: { tagName: 'BODY' }, metaKey: true })).toBe(true)
    expect(ignoreKey({ target: { tagName: 'BODY' } })).toBe(false)
  })
  it('listens only while fun mode is on and makes no request', async () => {
    const target = new EventTarget()
    const add = vi.spyOn(target, 'addEventListener')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const enabled = ref(false)
    const onMatch = vi.fn()
    const scope = effectScope()
    scope.run(() => useKonami(enabled, onMatch, () => target))
    const type = () => {
      for (const code of KONAMI) target.dispatchEvent(Object.assign(new Event('keydown'), { code, key: '' }))
    }
    type()
    expect(add).not.toHaveBeenCalled()
    expect(onMatch).not.toHaveBeenCalled()

    enabled.value = true
    await Promise.resolve()
    type()
    expect(onMatch).toHaveBeenCalledTimes(1)

    // Typing the code into a field does nothing.
    for (const code of KONAMI) {
      const e = new Event('keydown')
      Object.defineProperty(e, 'target', { value: { tagName: 'INPUT' } })
      target.dispatchEvent(Object.assign(e, { code }))
    }
    expect(onMatch).toHaveBeenCalledTimes(1)

    enabled.value = false
    await Promise.resolve()
    type()
    expect(onMatch).toHaveBeenCalledTimes(1)
    scope.stop()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the gimmick stays on its own surfaces', () => {
  it('only utils/funMode.ts names the fun.* lines; only state components use it', () => {
    const app = files(join(root, 'app'), /\.(vue|ts)$/)
    const naming = app.filter((f) => /['"`]fun\./.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length))
    expect(naming).toEqual(['app/utils/funMode.ts'])
    const users = app
      .filter((f) => /utils\/funMode['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length))
      .sort()
    expect(users).toEqual([
      'app/components/EmptyState.vue',
      'app/components/SkeletonDetail.vue',
      'app/components/SkeletonList.vue',
      'app/composables/useKonami.ts',
      'app/layouts/default.vue',
    ])
  })
  it('EmptyState lines only on whole-page, 404 and error states: never in tables, lists or filtered results', () => {
    // Every EmptyState call site, by file and test id (or title), with the wisdom it asks for. A new call site fails
    // here until it is classified; table, list and filter states must stay plain (no wisdom attribute).
    const sites: Record<string, string> = {}
    for (const f of files(join(root, 'app'), /\.vue$/)) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/<EmptyState\b([^>]*)>/g)) {
        const attrs = m[1]!
        const id = /data-testid="([^"]+)"/.exec(attrs)?.[1] ?? /:title="([^"]+)"/.exec(attrs)?.[1]
        const wisdom = /(?:^|\s):?wisdom="([^"]+)"/.exec(attrs)?.[1] ?? 'none'
        let key = `${f.slice(root.length)} ${id}`
        if (key in sites) key += ' #2'
        sites[key] = wisdom
      }
    }
    expect(sites).toEqual({
      // whole-page states: opted in
      'app/pages/todo/index.vue todo-empty': 'empty',
      'app/pages/requests/index.vue requests-empty': 'empty',
      'app/pages/status.vue status-empty': 'empty',
      'app/pages/agendas/index.vue agendas-empty': 'empty',
      'app/pages/chat.vue chat-empty': 'empty',
      "app/pages/answers.vue t('answers.empty')": 'empty',
      // 404 and errors
      'app/error.vue not-found': 'notFound',
      'app/error.vue error-page': 'error',
      'app/pages/projects/[id].vue load-error': 'notFound',
      'app/pages/work-items/[id].vue load-error': 'notFound',
      'app/pages/discussions/[id].vue load-error': 'notFound',
      'app/pages/todo/[id].vue load-error': 'notFound',
      'app/pages/agendas/[id]/index.vue load-error': 'notFound',
      "app/pages/requests/[id].vue t('requests.notFound')": 'notFound',
      // tables, lists, tabs and filtered results: plain
      'app/pages/todo/index.vue todo-filter-empty': 'none',
      'app/pages/admin/people.vue people-empty': 'none',
      'app/pages/settings/browsers.vue grants-empty': 'none',
      'app/pages/admin/browsers.vue grants-empty': 'none',
      'app/components/project/WorkItemsTab.vue items-empty': 'none',
      'app/components/project/WorkItemsTab.vue items-filter-empty': 'none',
      'app/components/project/KnowledgeTab.vue knowledge-empty': 'none',
      'app/components/project/KnowledgeTab.vue knowledge-empty #2': 'none',
      'app/pages/runners.vue runners-empty': 'none',
      'app/pages/projects/index.vue projects-empty': 'none',
      'app/pages/discussions/index.vue discussions-empty': 'none',
      'app/pages/agendas/[id]/index.vue agenda-empty': 'none',
      'app/pages/forbidden.vue forbidden': 'none',
    })
  })
  it('skeleton captions only on whole-page loads: tabs and in-page sections are quiet', () => {
    // Every SkeletonList / SkeletonDetail call site, by file (numbered when a file has several), quiet or not.
    // A new call site fails here until it is classified.
    const sites: Record<string, string> = {}
    for (const f of files(join(root, 'app'), /\.vue$/)) {
      const src = readFileSync(f, 'utf8')
      let n = 0
      for (const m of src.matchAll(/<(Skeleton(?:List|Detail))\b([^>]*)>/g)) {
        n += 1
        sites[`${f.slice(root.length)} ${m[1]}${n > 1 ? ` #${n}` : ''}`] = /(?:^|\s)quiet(?:\s|\/|=|$)/.test(m[2]!) ? 'quiet' : 'caption'
      }
    }
    expect(sites).toEqual({
      // whole-page loads: a caption in fun mode
      'app/pages/todo/index.vue SkeletonList': 'caption',
      'app/pages/todo/[id].vue SkeletonDetail': 'caption',
      'app/pages/requests/index.vue SkeletonList': 'caption',
      'app/pages/requests/[id].vue SkeletonDetail': 'caption',
      'app/pages/projects/index.vue SkeletonList': 'caption',
      'app/pages/projects/[id].vue SkeletonDetail': 'caption',
      'app/pages/work-items/[id].vue SkeletonDetail': 'caption',
      'app/pages/discussions/index.vue SkeletonList': 'caption',
      'app/pages/discussions/[id].vue SkeletonDetail': 'caption',
      'app/pages/agendas/index.vue SkeletonList': 'caption',
      'app/pages/agendas/[id]/index.vue SkeletonDetail': 'caption',
      'app/pages/answers.vue SkeletonList': 'caption',
      'app/pages/chat.vue SkeletonList': 'caption',
      'app/pages/runners.vue SkeletonList': 'caption',
      'app/pages/settings/notifications.vue SkeletonList': 'caption',
      'app/pages/admin/people.vue SkeletonList': 'caption',
      'app/pages/admin/ai.vue SkeletonList': 'caption',
      'app/pages/settings/browsers.vue SkeletonList': 'caption',
      'app/pages/admin/browsers.vue SkeletonList': 'caption',
      // project tabs and in-page sections: quiet
      'app/components/project/KnowledgeTab.vue SkeletonList': 'quiet',
      'app/components/project/WorkItemsTab.vue SkeletonList': 'quiet',
      'app/components/project/AiSettings.vue SkeletonList': 'quiet',
      'app/pages/work-items/[id].vue SkeletonList #2': 'quiet',
      // system settings: no fun lines in settings forms (owner rule)
      'app/pages/admin/settings/[page].vue SkeletonList': 'quiet',
      'app/components/settings/AiDepartment.vue SkeletonList': 'quiet',
      'app/components/settings/AuditLog.vue SkeletonList': 'quiet',
      'app/components/settings/AuditPanel.vue SkeletonList': 'quiet',
      'app/components/settings/GitlabStatus.vue SkeletonList': 'quiet',
    })
  })
  it('no fun line appears in core or shared code (notifications, emails, task data)', () => {
    const lines = ['th', 'en'].flatMap((l) => {
      const fun = locale(l).fun
      return [...(Object.keys(WISE_COUNTS) as WiseKind[]).flatMap((k) => fun[k] as string[]), fun.konami as string]
    })
    const sources = [...files(join(repo, 'apps/core/src'), /\.(ts|ftl|html|txt|md)$/), ...files(join(repo, 'packages/shared/src'), /\.ts$/)]
    expect(sources.length).toBeGreaterThan(20)
    for (const f of sources) {
      const text = readFileSync(f, 'utf8')
      for (const line of lines) expect(text.includes(line), `${f} contains "${line}"`).toBe(false)
    }
  })
  it('guard rail: no franchise names or film quotes in user-facing copy (only the product name Yoda)', () => {
    const banned = /star\s*wars|jedi|sith|padawan|lightsaber|light saber|skywalker|vader|darth|lucasfilm|disney|wookiee|galaxy far|do or do not|there is no try|size matters not|much to learn|the dark side|young one|force be with/i
    const texts: string[] = []
    const walk = (o: unknown) => {
      if (typeof o === 'string') texts.push(o)
      else if (o && typeof o === 'object') Object.values(o).forEach(walk)
    }
    walk(locale('th'))
    walk(locale('en'))
    const theme = join(repo, 'infra/keycloak/themes')
    for (const f of files(theme, /\.(properties|svg)$/)) {
      texts.push(...readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#') && !l.includes('<!--')))
    }
    texts.push(readFileSync(join(root, 'public/favicon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, ''))
    for (const s of texts) expect(s, s).not.toMatch(banned)
  })
})
