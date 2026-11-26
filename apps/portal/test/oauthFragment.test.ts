import { describe, expect, it } from 'vitest'
import { hashWithoutOAuth } from '../app/utils/oauthFragment'

describe('hashWithoutOAuth', () => {
  it('drops the sign-in callback parameters', () => {
    expect(hashWithoutOAuth('#state=s1&session_state=x&iss=http://localhost:8080/realms/yoda&code=c.d.e')).toBe('')
    expect(hashWithoutOAuth('#error=login_required&state=s1')).toBe('')
  })
  it('keeps an app hash next to them', () => {
    expect(hashWithoutOAuth('#comments&state=s1&code=c')).toBe('#comments')
  })
  it('leaves a hash that is not a callback alone', () => {
    expect(hashWithoutOAuth('')).toBeNull()
    expect(hashWithoutOAuth('#comments')).toBeNull()
    expect(hashWithoutOAuth('#code=snippet')).toBeNull()
    expect(hashWithoutOAuth('#state=open')).toBeNull()
  })
})
