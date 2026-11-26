/**
 * The optional "Jedi touch" (docs/design/jedi-touch.md): wise-master inverted word-order lines for empty, loading,
 * not-found and error states, and the Konami easter egg. Cosmetic only and switched by the admin fun-mode setting.
 * The lines live in i18n under `fun.*`; this file is the only place that names those keys, so the copy can never
 * leak into task data, tables, notifications or emails.
 */

/** How many lines each set has in `fun.<kind>.<n>` (th and en must match; see test/funMode.test.ts). */
export const WISE_COUNTS = { empty: 10, loading: 6, notFound: 3, error: 3 } as const
export type WiseKind = keyof typeof WISE_COUNTS

/** FNV-1a: a small, stable string hash, so a page always shows the same line. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The i18n key of the line for this kind of state on this page (rotates by route, not by time). */
export function wiseKey(kind: WiseKind, seed: string): string {
  return `fun.${kind}.${stableHash(`${kind}:${seed}`) % WISE_COUNTS[kind]}`
}

/** The line to show, or undefined when fun mode is off. */
export function wiseLine(enabled: boolean, kind: WiseKind, seed: string, t: (key: string) => string): string | undefined {
  return enabled ? t(wiseKey(kind, seed)) : undefined
}

export const KONAMI_TOAST_KEY = 'fun.konami'

/** ↑ ↑ ↓ ↓ ← → ← → B A, as `KeyboardEvent.code` values (B and A by key position, so a Thai layout works too). */
export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'] as const

type KeyLike = { code?: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

/** The key's code (falls back to the letter for B/A when the browser gives no code). */
export function keyCode(e: KeyLike): string {
  if (e.code) return e.code
  const k = (e.key ?? '').toLowerCase()
  return k === 'a' || k === 'b' ? `Key${k.toUpperCase()}` : e.key ?? ''
}

/** Adds a key to the recent-keys buffer; `matched` once the last ten keys are the code (the buffer then clears). */
export function konamiStep(buffer: readonly string[], code: string): { buffer: string[]; matched: boolean } {
  const next = [...buffer, code].slice(-KONAMI.length)
  const matched = next.length === KONAMI.length && next.every((c, i) => c === KONAMI[i])
  return { buffer: matched ? [] : next, matched }
}

type TargetLike = { tagName?: string; isContentEditable?: boolean } | null | undefined

/** Typing in a field (or a shortcut with a modifier) never counts towards the code. */
export function ignoreKey(e: KeyLike & { target?: unknown }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  const t = e.target as TargetLike
  if (!t) return false
  return !!t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName ?? '')
}
