import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EventType } from '@yoda/shared'
import { closesHint, mrStateColor, pipelineColor, syncStatusKey } from '../app/utils/gitlab'
import { errorKey } from '../app/utils/errors'

const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const LOCALES = { th: load('th.json'), en: load('en.json') }
const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)

describe('pipelineColor', () => {
  it('colours each pipeline status', () => {
    expect(pipelineColor('success')).toBe('success')
    expect(pipelineColor('failed')).toBe('error')
    expect(pipelineColor('running')).toBe('info')
    expect(pipelineColor('pending')).toBe('warning')
    expect(pipelineColor('canceled')).toBe('grey')
    expect(pipelineColor('none')).toBe('grey')
  })
})

describe('mrStateColor', () => {
  it('colours each merge request state', () => {
    expect(mrStateColor('merged')).toBe('success')
    expect(mrStateColor('opened')).toBe('info')
    expect(mrStateColor('closed')).toBe('grey')
  })
})

describe('syncStatusKey', () => {
  it('maps each sync status to a label key that exists in both locales', () => {
    for (const s of ['pending', 'synced', 'failed'] as const) {
      const key = syncStatusKey(s)
      for (const l of Object.values(LOCALES)) expect(typeof lookup(l, key), key).toBe('string')
    }
  })
})

describe('closesHint', () => {
  it('names the issue to close', () => {
    expect(closesHint(12)).toBe('Closes #12')
    expect(closesHint(null)).toBeNull()
  })
})

describe('timeline labels', () => {
  const LIVE_ONLY = new Set(['message.created', 'notification.created', 'run.heartbeat'])
  it('every stored event type (incl. gitlab.* and discussion.*) has a label in th and en', () => {
    const types = EventType.options.filter(t => !LIVE_ONLY.has(t))
    expect(types.some(t => t.startsWith('gitlab.'))).toBe(true)
    expect(types.some(t => t.startsWith('discussion.'))).toBe(true)
    for (const [name, l] of Object.entries(LOCALES)) {
      for (const t of types) expect(typeof lookup(l, `events.${t}`), `${name}: events.${t}`).toBe('string')
    }
  })
})

describe('gitlab error codes', () => {
  it('map to their own localized messages', () => {
    for (const code of ['gitlab_not_connected', 'repo_not_found', 'issue_not_found', 'gitlab_unavailable']) {
      const key = errorKey({ statusCode: 422, data: { error: code } })
      expect(key, code).not.toBe('errors.generic')
      for (const l of Object.values(LOCALES)) expect(typeof lookup(l, key), key).toBe('string')
    }
  })
})
