import { describe, expect, it } from 'vitest'
import { SETTINGS, SETTING_ENV_NAMES, SETTING_KEYS, byCategory, byEnvName, secretHint, settingDef } from '../src/index.js'

describe('settings registry', () => {
  it('has unique keys and env names', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length)
    const envNames = SETTING_KEYS.map((k) => settingDef(k).envName).filter(Boolean)
    expect(new Set(envNames).size).toBe(envNames.length)
    expect(SETTING_ENV_NAMES.length).toBe(envNames.length)
  })

  it('looks settings up by env name and category', () => {
    expect(byEnvName('SMTP_HOST')?.key).toBe('smtp.host')
    expect(byEnvName('PORTAL_URL')?.key).toBe('org.publicUrl')
    expect(byEnvName('NUXT_PUBLIC_ORG_LINE')?.key).toBe('org.line')
    expect(byEnvName('NOPE')).toBeUndefined()
    expect(byCategory('email').map((d) => d.key)).toEqual(['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.password', 'smtp.from'])
  })

  it('keeps bootstrap-only settings out of the UI (8.6, D9)', () => {
    for (const env of ['DATABASE_URL', 'YODA_MASTER_KEY', 'PORT', 'MIGRATE_ON_START', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION', 'LINE_API_URL', 'TELEGRAM_API_URL', 'YODA_VERSION', 'POSTGRES_PASSWORD', 'NUXT_CORE_URL']) {
      const d = byEnvName(env)!
      expect(d.bootstrapOnly, env).toBe(true)
      expect(d.uiEditable, env).toBe(false)
    }
    for (const d of SETTING_KEYS.map(settingDef)) if (d.bootstrapOnly) expect(d.uiEditable, d.key).toBe(false)
  })

  it('marks the inventory secrets secret', () => {
    const secrets = SETTING_KEYS.map(settingDef).filter((d) => d.secret && !d.bootstrapOnly).map((d) => d.key)
    expect(secrets.sort()).toEqual(
      ['ai.anthropicApiKey', 'ai.openaiApiKey', 'gitlab.token', 'gitlab.webhookSecret', 'smtp.password', 'line.accessToken', 'line.channelSecret', 'telegram.botToken', 'telegram.webhookSecret'].sort(),
    )
    expect(settingDef('smtp.password').boundTo).toEqual(['smtp.host'])
    expect(settingDef('gitlab.token').boundTo).toEqual(['gitlab.url'])
    expect(settingDef('ai.openaiApiKey').boundTo).toEqual(['ai.openaiBaseUrl'])
  })

  it('uses the apply modes of the inventory and R5', () => {
    expect(settingDef('ai.workers').apply).toBe('restart')
    expect(settingDef('runners.mcpEnabled').apply).toBe('restart')
    expect(settingDef('smtp.host').apply).toBe('reconnect')
    expect(settingDef('work.dailyTaskCap').apply).toBe('live')
  })

  it('parses env strings into typed values', () => {
    expect(SETTINGS['smtp.port'].schema.parse('465')).toBe(465)
    expect(SETTINGS['smtp.secure'].schema.parse('true')).toBe(true)
    expect(SETTINGS['smtp.secure'].schema.parse(false)).toBe(false)
    expect(SETTINGS['smtp.secure'].schema.safeParse('yes').success).toBe(false)
    expect(SETTINGS['gitlab.url'].schema.parse('https://gitlab.example.org/')).toBe('https://gitlab.example.org')
    expect(SETTINGS['oidc.bootstrapAdmins'].schema.parse(' a, b ,,')).toEqual(['a', 'b'])
    expect(SETTINGS['telegram.botUsername'].schema.parse('@yoda_bot')).toBe('yoda_bot')
    expect(SETTINGS['runners.leaseSeconds'].schema.safeParse('60').success).toBe(false)
    expect(SETTINGS['ai.modelDraft'].schema.safeParse('gpt-4').success).toBe(false)
    expect(SETTINGS['gitlab.webhookSecret'].schema.safeParse('short').success).toBe(false)
  })

  it('defaults validate against their own schema', () => {
    for (const d of SETTING_KEYS.map(settingDef)) {
      if (d.default !== undefined) expect(d.schema.safeParse(d.default).success, d.key).toBe(true)
    }
  })

  it('shows the last 4 characters only for long secrets', () => {
    expect(secretHint('x'.repeat(19))).toBeNull()
    expect(secretHint(`${'x'.repeat(16)}a1b2`)).toBe('a1b2')
  })
})
