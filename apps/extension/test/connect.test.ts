import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserLabel, normaliseYodaUrl, onConnectClick, pkcePair } from '../src/connect/connect'
import { installChrome, type FakeChrome } from './support/chrome'

let c: FakeChrome
const publicConfig = (enabled = true) => ({
  oidc: null,
  org: { name: 'โรงพยาบาลตัวอย่าง', nameEn: 'Example hospital', line: null, defaultLocale: 'th' },
  runnerDocsUrl: null,
  line: { addFriendUrl: null },
  funMode: false,
  setup: 'done',
  recovery: false,
  recoveryForced: false,
  version: '1.2.0',
  extension: { enabled, apiVersion: 1 },
})

beforeEach(() => {
  c = installChrome()
  vi.restoreAllMocks()
})

function stubFetch(config: unknown = publicConfig()) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    c.calls.push(`fetch:${String(input)}`)
    return new Response(JSON.stringify(config), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

describe('normaliseYodaUrl', () => {
  it('refuses http to a non-localhost host', () => {
    expect(normaliseYodaUrl('http://yoda.example.org')).toEqual({ ok: false, reason: 'insecure' })
  })
  it('accepts http://localhost:5173, 127.0.0.1 and https, dropping paths', () => {
    expect(normaliseYodaUrl('http://localhost:5173')).toEqual({ ok: true, origin: 'http://localhost:5173' })
    expect(normaliseYodaUrl('http://127.0.0.1:3000/x')).toEqual({ ok: true, origin: 'http://127.0.0.1:3000' })
    expect(normaliseYodaUrl(' yoda.example.org/todo ')).toEqual({ ok: true, origin: 'https://yoda.example.org' })
    expect(normaliseYodaUrl('https://Yoda.Example.org:8443/')).toEqual({ ok: true, origin: 'https://yoda.example.org:8443' })
    expect(normaliseYodaUrl('ftp://x.example.org')).toEqual({ ok: false, reason: 'invalid' })
    expect(normaliseYodaUrl('')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('onConnectClick', () => {
  it('permissions.request is the first await of the click handler', async () => {
    stubFetch()
    c.identity.launchWebAuthFlow = async () => undefined
    const p = onConnectClick('https://yoda.example.org')
    // Synchronously, before the handler awaited anything: the request is already made, nothing else is.
    expect(c.calls).toEqual(['permissions.request:https://yoda.example.org/*'])
    await p
    expect(c.calls[1]).toBe('fetch:https://yoda.example.org/api/public-config')
  })

  it('a refused permission ends the flow', async () => {
    stubFetch()
    c.permissions.request = async () => false
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: false, reason: 'permission_needed' })
  })

  it("refuses a site whose public-config is not Yoda, and removes the origin permission", async () => {
    stubFetch({ hello: 'world' })
    expect(await onConnectClick('https://other.example.org')).toEqual({ ok: false, reason: 'not_yoda' })
    expect(c.calls).toContain('permissions.remove:https://other.example.org/*')
    stubFetch(publicConfig(false))
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: false, reason: 'extension_disabled' })
  })

  it('a state mismatch aborts without exchanging', async () => {
    stubFetch()
    const sent: unknown[] = []
    c.runtime.sendMessage = async (m: unknown) => sent.push(m)
    c.identity.launchWebAuthFlow = async () => `https://${c.runtime.id}.chromiumapp.org/?code=yoda_xc_x&state=wrong`
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(sent).toEqual([])
  })

  it('error=access_denied gives a cancelled result; a closed window too', async () => {
    stubFetch()
    let state = ''
    c.identity.launchWebAuthFlow = async ({ url }) => {
      state = new URL(url).searchParams.get('state')!
      return `https://${c.runtime.id}.chromiumapp.org/?error=access_denied&state=${state}`
    }
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: false, reason: 'cancelled' })
    c.identity.launchWebAuthFlow = async () => {
      throw new Error('The user did not approve access.')
    }
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('opens the approve page with the extension ID, its own redirect and an S256 challenge, then asks the worker to exchange', async () => {
    stubFetch()
    let opened = ''
    c.identity.launchWebAuthFlow = async ({ url }) => {
      opened = url
      const u = new URL(url)
      return `${u.searchParams.get('redirect_uri')}?code=yoda_xc_abc&state=${u.searchParams.get('state')}`
    }
    const sent: Record<string, string>[] = []
    c.runtime.sendMessage = async (m: unknown) => {
      sent.push(m as Record<string, string>)
      return { ok: true, profileId: 'p1' }
    }
    expect(await onConnectClick('https://yoda.example.org')).toEqual({ ok: true, profileId: 'p1' })
    const u = new URL(opened)
    expect(`${u.origin}${u.pathname}`).toBe('https://yoda.example.org/extension/connect')
    expect(u.searchParams.get('ext')).toBe(c.runtime.id)
    expect(u.searchParams.get('redirect_uri')).toBe(`https://${c.runtime.id}.chromiumapp.org/`)
    const verifier = sent[0]!.verifier!
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
    expect(u.searchParams.get('code_challenge')).toBe(digest)
    expect(sent[0]).toMatchObject({ type: 'profile.exchange', origin: 'https://yoda.example.org', code: 'yoda_xc_abc' })
  })
})

describe('PKCE and the browser label', () => {
  it('the PKCE challenge is S256 of the verifier', async () => {
    const { verifier, challenge } = await pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'))
  })
  it('names the browser from userAgentData, at most 120 characters', () => {
    expect(browserLabel({ brands: [{ brand: 'Not A;Brand', version: '99' }, { brand: 'Microsoft Edge', version: '131' }, { brand: 'Chromium', version: '131' }], platform: 'Windows' })).toBe('Edge 131 · Windows')
    expect(browserLabel({ brands: [{ brand: 'Google Chrome', version: '131' }], platform: 'macOS' })).toBe('Chrome 131 · macOS')
    expect(browserLabel(undefined)).toBe('Chrome')
    expect(browserLabel({ brands: [{ brand: 'x'.repeat(300), version: '1' }], platform: 'y' }).length).toBeLessThanOrEqual(120)
  })
})
