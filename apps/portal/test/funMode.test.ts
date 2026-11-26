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
  it('EmptyState: a line only in fun mode; explicit secondary always; wisdom false stays plain', async () => {
    setFun(false)
    expect(await render(EmptyState, { title: 'x' })).not.toContain('empty-secondary')
    expect(await render(EmptyState, { title: 'x', wisdom: 'notFound' })).not.toContain('fun.')
    expect(await render(EmptyState, { title: 'x', secondary: 'given' })).toContain('given')
    setFun(true)
    expect(await render(EmptyState, { title: 'x' })).toContain(wiseKey('empty', '/todo'))
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
