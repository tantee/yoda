import { describe, expect, it } from 'vitest'
import { apply, initState, nextStepNumber, redo, undo, type Op } from '../src/editor/doc'

const box: Op = { kind: 'box', rect: { x: 1, y: 1, w: 10, h: 10 }, colour: '#B3261E' }
const step = (n: number): Op => ({ kind: 'step', at: { x: n, y: n }, n })

describe('editor history', () => {
  it('undo and redo restore the exact doc', () => {
    let s = initState({ width: 100, height: 50, ops: [] })
    s = apply(s, { add: box })
    s = apply(s, { add: step(1) })
    const after = s.doc
    s = undo(s)
    expect(s.doc.ops).toEqual([box])
    s = redo(s)
    expect(s.doc).toEqual(after)
  })
  it('a new op clears the redo stack', () => {
    let s = initState({ width: 1, height: 1, ops: [] })
    s = apply(s, { add: box })
    s = undo(s)
    s = apply(s, { add: step(1) })
    expect(s.future).toEqual([])
    expect(redo(s)).toEqual(s)
  })
  it('history is capped at 100', () => {
    let s = initState({ width: 1, height: 1, ops: [] })
    for (let i = 0; i < 150; i++) s = apply(s, { add: step(i) })
    expect(s.past).toHaveLength(100)
  })
  it('step numbers continue after undo', () => {
    let s = initState({ width: 1, height: 1, ops: [] })
    s = apply(s, { add: step(nextStepNumber(s.doc)) })
    s = apply(s, { add: step(nextStepNumber(s.doc)) })
    s = undo(s)
    expect(nextStepNumber(s.doc)).toBe(2)
  })
  it('remove and replace an op', () => {
    let s = initState({ width: 1, height: 1, ops: [box, step(1)] })
    s = apply(s, { remove: 0 })
    expect(s.doc.ops).toEqual([step(1)])
    s = apply(s, { replace: [0, step(5)] })
    expect(s.doc.ops).toEqual([step(5)])
  })
})
