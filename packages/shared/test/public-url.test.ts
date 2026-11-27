import { describe, expect, it } from 'vitest'
import { isLocalhostHost, publicUrlIssue } from '../src/index.js'

// D8 (owner decision, 2026-11-27): the public URL is https, or plain http on this machine only.
describe('public URL rule (D8)', () => {
  it('counts localhost, *.localhost, 127.0.0.0/8 and ::1 as this machine, nothing else', () => {
    for (const h of ['localhost', 'LOCALHOST', 'yoda.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLocalhostHost(h), h).toBe(true)
    for (const h of ['localhost.example.org', '127.example.org', '10.0.0.5', '0.0.0.0', '::ffff:10.0.0.5', '', null, undefined]) expect(isLocalhostHost(h), String(h)).toBe(false)
  })

  it('refuses plain http away from this machine with https_required', () => {
    for (const u of ['http://10.0.0.5:3000', 'http://192.168.1.20', 'http://portal.example.org', 'http://0.0.0.0:3000', 'HTTP://Portal.Example.org']) expect(publicUrlIssue(u), u).toBe('https_required')
    for (const u of ['https://portal.example.org', 'https://10.0.0.5', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://yoda.localhost', 'http://127.1']) {
      expect(publicUrlIssue(u), u).toBeNull()
    }
    // Not a URL: the schema reports it, not this rule.
    for (const u of ['nonsense', '', null, undefined]) expect(publicUrlIssue(u)).toBeNull()
  })
})
