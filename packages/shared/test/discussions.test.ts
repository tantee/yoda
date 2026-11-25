import { describe, expect, it } from 'vitest'
import { DiscussionCreate, DiscussionResponseCreate } from '../src/index.js'

const id = '11111111-1111-4111-8111-111111111111'

describe('discussion schemas', () => {
  it('rejects a vote without an option', () => {
    expect(DiscussionResponseCreate.safeParse({ kind: 'vote' }).success).toBe(false)
    expect(DiscussionResponseCreate.safeParse({ kind: 'vote', optionKey: 'a' }).success).toBe(true)
  })
  it('rejects an opinion with blank text', () => {
    expect(DiscussionResponseCreate.safeParse({ kind: 'opinion', text: '   ' }).success).toBe(false)
    expect(DiscussionResponseCreate.safeParse({ kind: 'opinion', text: 'เห็นด้วย' }).success).toBe(true)
  })
  it('rejects taskId without workItemId', () => {
    expect(DiscussionCreate.safeParse({ question: 'q', taskId: id }).success).toBe(false)
    expect(DiscussionCreate.safeParse({ question: 'q', taskId: id, workItemId: id }).success).toBe(true)
  })
  it('trims a Thai question and applies defaults', () => {
    const r = DiscussionCreate.parse({ question: '  ควรใช้ระบบไหน  ' })
    expect(r.question).toBe('ควรใช้ระบบไหน')
    expect(r.priority).toBe('normal')
    expect(r.requestBrief).toBe(true)
  })
})
