import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ChannelName, NotificationKind, type MyNotificationPrefs } from '@yoda/shared'
import { channelColumns, channelKey, isChecked, kindKey, toggleChannel } from '../app/utils/notificationSettings'
import { errorKey } from '../app/utils/errors'
import { navItemsFor } from '../app/utils/nav'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const LOCALES = { th: load('th.json'), en: load('en.json') }
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

const my = (over: Partial<MyNotificationPrefs['channels']> = {}): MyNotificationPrefs => ({
  kinds: ['request_update', 'secretary_message'],
  prefs: { kinds: { request_update: ['email'], secretary_message: [] } },
  channels: { available: ['email'], linked: { email: true, line: false, telegram: false }, ...over },
})

describe('channelColumns', () => {
  it('shows every channel; only available and linked ones are usable', () => {
    expect(channelColumns(my())).toEqual([
      { name: 'email', available: true, linked: true, usable: true },
      { name: 'line', available: false, linked: false, usable: false },
      { name: 'telegram', available: false, linked: false, usable: false },
    ])
  })
  it('email without an address is not usable', () => {
    expect(channelColumns(my({ linked: { email: false, line: false, telegram: false } }))[0]!.usable).toBe(false)
  })
})

describe('toggleChannel', () => {
  it('adds and removes a channel for one kind without touching the others', () => {
    const p = my().prefs
    const on = toggleChannel(p, 'secretary_message', 'email', true)
    expect(on.kinds).toEqual({ request_update: ['email'], secretary_message: ['email'] })
    expect(isChecked(on, 'secretary_message', 'email')).toBe(true)
    const off = toggleChannel(on, 'request_update', 'email', false)
    expect(off.kinds.request_update).toEqual([])
    expect(p.kinds.secretary_message).toEqual([])
  })
  it('keeps channel order stable', () => {
    const p = toggleChannel(toggleChannel({ kinds: {} }, 'discussion', 'telegram', true), 'discussion', 'email', true)
    expect(p.kinds.discussion).toEqual(['email', 'telegram'])
  })
})

describe('labels', () => {
  it('every kind, channel and the new errors have th and en text', () => {
    const keys = [
      ...NotificationKind.options.map(kindKey),
      ...ChannelName.options.map(channelKey),
      errorKey({ data: { error: 'invalid_prefs' } }),
      errorKey({ data: { error: 'channel_not_configured' } }),
      'nav.admin.notifications',
    ]
    for (const key of keys) {
      for (const [, locale] of Object.entries(LOCALES)) expect(typeof lookup(locale, key), key).toBe('string')
    }
  })
  it('the admin page is in the admin nav only', () => {
    const base = { id: crypto.randomUUID(), username: 'u', displayName: 'U', email: null }
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: true }).map(i => i.key)).toContain('nav.admin.notifications')
    expect(navItemsFor({ ...base, isStaff: true, isAdmin: false }).map(i => i.key)).not.toContain('nav.admin.notifications')
  })
})
