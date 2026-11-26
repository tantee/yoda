import { describe, expect, it } from 'vitest'
import { sessionEnded } from '../app/utils/session'

const now = Date.UTC(2026, 10, 26, 3, 0, 0)
const sec = Math.ceil(now / 1000)

describe('sessionEnded', () => {
  it('has ended when there is no refresh token (keycloak-js cleared it after Keycloak refused the refresh)', () => {
    expect(sessionEnded({}, now)).toBe(true)
    expect(sessionEnded({ refreshToken: '', refreshTokenParsed: { exp: sec + 3600 } }, now)).toBe(true)
  })
  it('has ended when the refresh token has expired, with a few seconds of slack', () => {
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: { exp: sec - 60 } }, now)).toBe(true)
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: { exp: sec + 2 } }, now)).toBe(true)
  })
  it('has not ended while the refresh token is still valid (offline, Keycloak briefly down)', () => {
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: { exp: sec + 600 } }, now)).toBe(false)
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: {} }, now)).toBe(false)
    expect(sessionEnded({ refreshToken: 'r' }, now)).toBe(false)
  })
  it('allows for the clock difference keycloak-js measured', () => {
    // timeSkew is the browser clock minus Keycloak's: at -120 the browser runs 2 minutes behind, so exp (60s away by
    // the browser clock) has already passed for Keycloak; at +120 it runs ahead and an exp 60s ago is still a minute off.
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: { exp: sec + 60 }, timeSkew: -120 }, now)).toBe(true)
    expect(sessionEnded({ refreshToken: 'r', refreshTokenParsed: { exp: sec - 60 }, timeSkew: 120 }, now)).toBe(false)
  })
})
