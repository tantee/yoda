import { describe, expect, it } from 'vitest'
import { parseSse } from '../app/utils/sse'

describe('parseSse', () => {
  it('parses events, skips comments, keeps the partial rest', () => {
    const r = parseSse(': connected\n\nevent: live\ndata: {"a":1}\n\nevent: li')
    expect(r.events).toEqual([{ event: 'live', data: '{"a":1}' }])
    expect(r.rest).toBe('event: li')
  })
  it('handles CRLF separators', () => {
    const r = parseSse(': connected\r\n\r\nevent: live\r\ndata: {"a":1}\r\n\r\nevent: li')
    expect(r.events).toEqual([{ event: 'live', data: '{"a":1}' }])
    expect(r.rest).toBe('event: li')
  })
  it('joins multi-line data with newline', () => {
    const r = parseSse('event: live\ndata: one\ndata: two\n\n')
    expect(r.events).toEqual([{ event: 'live', data: 'one\ntwo' }])
    expect(r.rest).toBe('')
  })
})
