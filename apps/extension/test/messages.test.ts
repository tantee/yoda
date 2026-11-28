import { beforeEach, describe, expect, it } from 'vitest'
import { Msg, onMessage, senderKind } from '../src/sw/messages'
import { installChrome, type FakeChrome } from './support/chrome'

const ID = 'hcnhkfonaflhcknbhcphbfgpdfmgmibm'
let chromeFake: FakeChrome
beforeEach(() => {
  chromeFake = installChrome({ id: ID })
})

describe('senderKind', () => {
  it('an extension page in a tab is page; a web page with our id is content; another id is foreign', () => {
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}/src/editor/index.html?draft=1`, tab: { id: 3 } as chrome.tabs.Tab }, ID)).toBe('page')
    expect(senderKind({ id: ID, origin: `chrome-extension://${ID}` }, ID)).toBe('page')
    expect(senderKind({ id: ID, url: 'https://app.example.org/opd', tab: { id: 3 } as chrome.tabs.Tab }, ID)).toBe('content')
    expect(senderKind({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html` }, ID)).toBe('foreign')
    // A look-alike origin is never one of our pages.
    expect(senderKind({ id: ID, url: `chrome-extension://${ID}.evil.example.org/` }, ID)).toBe('foreign')
    expect(senderKind({ id: ID }, ID)).toBe('foreign')
  })
})

describe('onMessage', () => {
  const page = { id: ID, url: `chrome-extension://${ID}/src/popup/index.html` }
  const content = { id: ID, url: 'https://app.example.org/', tab: { id: 7 } as chrome.tabs.Tab }

  it('token.get from content is refused', async () => {
    const seen: string[] = []
    onMessage(async (m) => {
      seen.push(m.type)
      return { ok: true }
    })
    expect(await chromeFake.runtime.deliver({ type: 'token.get', profileId: 'p1' }, content)).toEqual({ ok: false, error: 'forbidden' })
    expect(await chromeFake.runtime.deliver({ type: 'token.get', profileId: 'p1' }, page)).toEqual({ ok: true })
    expect(seen).toEqual(['token.get'])
  })

  it('content may send only capture.collected, with the nonce of its injection', async () => {
    const seen: string[] = []
    onMessage(async (m) => {
      seen.push(m.type)
      return { ok: true }
    }, { nonceFor: async (tabId) => (tabId === 7 ? 'n-7' : null) })
    const collected = { type: 'capture.collected', nonce: 'n-7', entries: [] }
    expect(await chromeFake.runtime.deliver(collected, content)).toEqual({ ok: true })
    expect(await chromeFake.runtime.deliver({ ...collected, nonce: 'n-8' }, content)).toEqual({ ok: false, error: 'forbidden' })
    expect(await chromeFake.runtime.deliver({ type: 'session.get', profileId: 'p1' }, content)).toEqual({ ok: false, error: 'forbidden' })
    expect(seen).toEqual(['capture.collected'])
  })

  it('a foreign sender gets nothing', async () => {
    onMessage(async () => ({ ok: true }))
    expect(await chromeFake.runtime.deliver({ type: 'session.get', profileId: 'p1' }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toEqual({ ok: false, error: 'forbidden' })
  })

  it('unknown message types are rejected by the schema', async () => {
    expect(Msg.safeParse({ type: 'eval', code: '1' }).success).toBe(false)
    expect(Msg.safeParse({ type: 'token.get' }).success).toBe(false)
    onMessage(async () => ({ ok: true }))
    expect(await chromeFake.runtime.deliver({ type: 'eval' }, page)).toEqual({ ok: false, error: 'invalid' })
  })
})
