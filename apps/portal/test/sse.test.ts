import { describe, expect, it } from 'vitest'
import { parseSse, streamStep } from '../app/utils/sse'

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

describe('streamStep', () => {
  it('signs in again when a refresh fails only if the session ended, else reconnects', () => {
    expect(streamStep({ tokenOk: false, sessionEnded: true, retriedAuth: false })).toBe('login')
    expect(streamStep({ tokenOk: false, sessionEnded: true, retriedAuth: true })).toBe('login')
    expect(streamStep({ tokenOk: false, sessionEnded: false, retriedAuth: false })).toBe('reconnect')
    expect(streamStep({ tokenOk: false, sessionEnded: false, retriedAuth: true })).toBe('reconnect')
    expect(streamStep({ tokenOk: false, retriedAuth: false })).toBe('reconnect')
  })
  it('on a 401 forces a token refresh and retries once, then signs in again while online', () => {
    expect(streamStep({ tokenOk: true, status: 401, retriedAuth: false })).toBe('refresh-retry')
    expect(streamStep({ tokenOk: true, status: 401, retriedAuth: true })).toBe('login')
    expect(streamStep({ tokenOk: true, status: 401, retriedAuth: true, online: true })).toBe('login')
    expect(streamStep({ tokenOk: true, status: 401, retriedAuth: true, online: false })).toBe('reconnect')
  })
  it('streams on success and reconnects with backoff on other failures', () => {
    expect(streamStep({ tokenOk: true, status: 200, retriedAuth: false })).toBe('stream')
    expect(streamStep({ tokenOk: true, status: 200, retriedAuth: true })).toBe('stream')
    expect(streamStep({ tokenOk: true, status: 502, retriedAuth: false })).toBe('reconnect')
    expect(streamStep({ tokenOk: true, status: 403, retriedAuth: false })).toBe('reconnect')
    expect(streamStep({ tokenOk: true, retriedAuth: false })).toBe('reconnect')
  })
})
