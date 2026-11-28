import type { Rect } from './pixels'

export type Point = { x: number; y: number }
/** One annotation. Blur, redact and mosaic change pixels; the others are drawn on top; the last crop applies. */
export type Op =
  | { kind: 'arrow'; points: [number, number, number, number]; colour: string; width: number }
  | { kind: 'box' | 'highlight'; rect: Rect; colour: string }
  | { kind: 'text'; at: Point; text: string; colour: string; size: number }
  | { kind: 'step'; at: Point; n: number }
  | { kind: 'blur'; rect: Rect; radius: number }
  | { kind: 'redact'; rect: Rect }
  | { kind: 'mosaic'; mode: 'rect'; rect: Rect; block: number }
  | { kind: 'mosaic'; mode: 'brush'; points: number[]; width: number; block: number }
  | { kind: 'crop'; rect: Rect }
export type EditorDoc = { width: number; height: number; ops: Op[] }
export type State = { doc: EditorDoc; past: EditorDoc[]; future: EditorDoc[] }
export type Cmd = { add: Op } | { remove: number } | { replace: [number, Op] }

export const HISTORY_MAX = 100

export function initState(doc: EditorDoc): State {
  return { doc, past: [], future: [] }
}

/** Applies a change; it becomes one undo step and clears the redo stack. */
export function apply(s: State, cmd: Cmd): State {
  const ops = [...s.doc.ops]
  if ('add' in cmd) ops.push(cmd.add)
  else if ('remove' in cmd) ops.splice(cmd.remove, 1)
  else ops[cmd.replace[0]] = cmd.replace[1]
  return { doc: { ...s.doc, ops }, past: [...s.past, s.doc].slice(-HISTORY_MAX), future: [] }
}

export function undo(s: State): State {
  const prev = s.past.at(-1)
  return prev ? { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future] } : s
}

export function redo(s: State): State {
  const next = s.future[0]
  return next ? { doc: next, past: [...s.past, s.doc].slice(-HISTORY_MAX), future: s.future.slice(1) } : s
}

/** The next step marker's number: one more than the highest present. */
export function nextStepNumber(doc: EditorDoc): number {
  return doc.ops.reduce((n, o) => (o.kind === 'step' ? Math.max(n, o.n) : n), 0) + 1
}

/** The default mosaic block for an image: about 1/60 of its short side, at least 12 pixels. */
export const defaultBlock = (w: number, h: number) => Math.max(12, Math.round(Math.min(w, h) / 60))
