import { settingDef, type SettingKey, type SettingValue, type SettingsTestAction, type SettingsTestCheck, type SettingsTestResult } from '@yoda/shared'
import { createTransport } from 'nodemailer'
import { isIP } from 'node:net'
import { isPriced } from '../ai/gateway.js'
import { parseModelId } from '../ai/models.js'
import type { Storage } from '../storage/s3.js'
import { OutboundError, isLoopback, resolveOutbound, safeFetch, type OutboundPolicy, type SafeResponse } from './outbound.js'

/**
 * The settings test actions (installer proposal §5.2, §8.5, §9). Each runs against the values it is given (draft
 * values merged over the saved ones by the caller) and returns checks with short codes: never a server's content,
 * a value or an address. Every connection goes through `safeOutbound`, except the storage test, which checks the
 * bootstrap-only S3 settings from env (D9) and takes no draft values.
 */

export type TestContext = {
  /** The value to test with: a draft value, else the saved one. A secret is undefined when it must be re-entered. */
  get<K extends SettingKey>(key: K): SettingValue<K> | undefined
  policy: OutboundPolicy
  storage?: Pick<Storage, 'ping'>
  /** Email: also send a test message to this address (the admin's own). */
  sendTo?: string | null
  /** The Anthropic API base (tests point it at a fake). */
  anthropicUrl?: string
  /** Telegram: the bot username from `getMe`, when the tested token is the saved one. */
  onTelegramUsername?: (username: string) => Promise<void>
}

type Outcome = { ok: boolean; code?: string; detail?: SettingsTestCheck['detail'] }

class CheckFailed extends Error {
  constructor(
    readonly code: string,
    readonly detail?: SettingsTestCheck['detail'],
  ) {
    super(code)
  }
}

const fail = (code: string, detail?: SettingsTestCheck['detail']): never => {
  throw new CheckFailed(code, detail)
}

async function check(id: string, fn: () => Promise<Outcome | void>): Promise<SettingsTestCheck> {
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  try {
    const r = (await fn()) ?? { ok: true }
    return { id, ok: r.ok, ms: ms(), ...(r.code ? { code: r.code } : {}), ...(r.detail ? { detail: r.detail } : {}) }
  } catch (err) {
    if (err instanceof CheckFailed) return { id, ok: false, ms: ms(), code: err.code, ...(err.detail ? { detail: err.detail } : {}) }
    if (err instanceof OutboundError) return { id, ok: false, ms: ms(), code: err.code }
    return { id, ok: false, ms: ms(), code: 'failed' }
  }
}

function json(res: SafeResponse): unknown {
  try {
    return JSON.parse(res.body)
  } catch {
    return fail('invalid_response')
  }
}

/** 2xx, else `auth_rejected` for 401/403, else `http_<status>`. */
function expectOk(res: SafeResponse): void {
  if (res.status >= 200 && res.status < 300) return
  if (res.status === 401 || res.status === 403) fail('auth_rejected')
  fail(`http_${res.status}`)
}

const notConfigured = (id: string) => ({ id, ok: false, ms: 0, code: 'not_configured' }) satisfies SettingsTestCheck

/** A secret bound to an endpoint the draft changes must be entered again (8.6); undefined otherwise. */
const secretMissing = (id: string) => ({ id, ok: false, ms: 0, code: 'secret_required' }) satisfies SettingsTestCheck

async function oidc(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const issuer = ctx.get('oidc.issuer')
  if (!issuer) return [notConfigured('discovery')]
  let doc: { issuer?: unknown; jwks_uri?: unknown; authorization_endpoint?: unknown } = {}
  const checks = [
    await check('discovery', async () => {
      const res = await safeFetch(`${issuer}/.well-known/openid-configuration`, { policy: ctx.policy })
      expectOk(res)
      doc = (json(res) ?? {}) as typeof doc
      if (doc.issuer !== issuer) fail('issuer_mismatch')
    }),
  ]
  if (!checks[0]!.ok) return checks
  checks.push(
    await check('jwks', async () => {
      const url = ctx.get('oidc.jwksUrl') ?? (typeof doc.jwks_uri === 'string' ? doc.jwks_uri : `${issuer}/protocol/openid-connect/certs`)
      const res = await safeFetch(url, { policy: ctx.policy })
      expectOk(res)
      const keys = (json(res) as { keys?: unknown } | null)?.keys
      const signing = Array.isArray(keys) ? keys.filter((k) => (k as { use?: unknown })?.use !== 'enc').length : 0
      if (!signing) fail('no_keys')
      return { ok: true, detail: { keys: signing } }
    }),
  )
  // The authorization endpoint answers 400 for an unknown client or a redirect URI it does not allow, and shows
  // its sign-in page (200) otherwise. No cookies are sent, so no session can short-circuit it.
  checks.push(
    await check('client', async () => {
      const clientId = ctx.get('oidc.clientId')
      if (!clientId) fail('not_configured')
      if (typeof doc.authorization_endpoint !== 'string') fail('invalid_response')
      const url = new URL(doc.authorization_endpoint as string)
      url.searchParams.set('client_id', clientId!)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'openid')
      url.searchParams.set('redirect_uri', `${ctx.get('org.publicUrl') ?? ''}/`)
      const res = await safeFetch(url, { policy: ctx.policy })
      if (res.status === 400) fail('client_rejected')
      if (res.status >= 400) fail(`http_${res.status}`)
    }),
  )
  return checks
}

/** Submission, submissions over TLS, and the common alternates (a dev catcher on 1025). */
const SMTP_PORTS = new Set([25, 465, 587, 2525, 1025])

function smtpCode(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown }
  const msg = typeof e?.message === 'string' ? e.message : ''
  if (e?.code === 'EAUTH' || e?.code === 'ENOAUTH') return 'auth_rejected'
  if (e?.code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'timeout'
  if (e?.code === 'ETLS' || /certificate|tls|ssl|self.signed/i.test(msg)) return 'tls_failed'
  if (e?.code === 'ECONNECTION' || e?.code === 'ESOCKET' || e?.code === 'ECONNREFUSED') return 'connect_failed'
  if (typeof e?.responseCode === 'number') return `smtp_${e.responseCode}`
  return 'smtp_error'
}

async function smtp(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const host = ctx.get('smtp.host')
  if (!host) return [notConfigured('connect')]
  const port = ctx.get('smtp.port') ?? 587
  const user = ctx.get('smtp.user')
  const password = ctx.get('smtp.password')
  if (user && password === undefined) return [secretMissing('connect')]
  let transport: ReturnType<typeof createTransport> | null = null
  const checks = [
    await check('connect', async () => {
      const target = await resolveOutbound(host, ctx.policy)
      // Only SMTP ports, so the test cannot probe other services; the dev fakes on loopback use any port.
      if (!SMTP_PORTS.has(port) && !(ctx.policy.allowLoopback && isLoopback(target.address))) fail('blocked_port')
      // Connect to the address resolved and checked once; TLS still checks the certificate for the host name.
      transport = createTransport({
        host: target.address,
        port,
        secure: ctx.get('smtp.secure') ?? false,
        ...(isIP(host) ? {} : { tls: { servername: host } }),
        auth: user ? { user, pass: password ?? '' } : undefined,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
      })
      try {
        await transport.verify()
      } catch (err) {
        fail(smtpCode(err))
      }
      return { ok: true, detail: { auth: Boolean(user) } }
    }),
  ]
  if (checks[0]!.ok && ctx.sendTo !== undefined) {
    checks.push(
      await check('send', async () => {
        const from = ctx.get('smtp.from')
        if (!from) fail('no_sender')
        if (!ctx.sendTo) fail('no_address')
        try {
          await transport!.sendMail({ from, to: ctx.sendTo!, subject: 'Yoda: test email', text: 'This is a test message from Yoda settings.' })
        } catch (err) {
          fail(smtpCode(err))
        }
      }),
    )
  }
  ;(transport as ReturnType<typeof createTransport> | null)?.close()
  return checks
}

async function line(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const token = ctx.get('line.accessToken')
  if (!token) return [notConfigured('bot')]
  return [
    await check('bot', async () => {
      const res = await safeFetch(`${ctx.get('line.apiUrl')}/v2/bot/info`, { headers: { authorization: `Bearer ${token}` }, policy: ctx.policy })
      expectOk(res)
      const b = json(res) as { basicId?: unknown } | null
      return { ok: true, detail: { basicId: typeof b?.basicId === 'string' ? b.basicId.slice(0, 64) : null } }
    }),
  ]
}

const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/

async function telegram(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const token = ctx.get('telegram.botToken')
  if (!token) return [notConfigured('bot')]
  const api = `${ctx.get('telegram.apiUrl')}/bot${token}`
  const checks = [
    await check('bot', async () => {
      // The token is in the path: safeFetch never puts a URL in an error, and nothing here logs it.
      const res = await safeFetch(`${api}/getMe`, { policy: ctx.policy })
      if (res.status === 401 || res.status === 404) fail('auth_rejected')
      expectOk(res)
      const username = (json(res) as { result?: { username?: unknown } } | null)?.result?.username
      if (typeof username !== 'string' || !BOT_USERNAME.test(username)) fail('invalid_response')
      await ctx.onTelegramUsername?.(username as string)
      return { ok: true, detail: { username: username as string } }
    }),
  ]
  if (!checks[0]!.ok) return checks
  checks.push(
    await check('webhook', async () => {
      const res = await safeFetch(`${api}/getWebhookInfo`, { policy: ctx.policy })
      expectOk(res)
      const info = (json(res) as { result?: { url?: unknown; pending_update_count?: unknown; last_error_date?: unknown } } | null)?.result
      const registered = info?.url === telegramWebhookUrl(ctx.get('org.publicUrl') ?? '')
      return {
        ok: registered,
        ...(registered ? {} : { code: 'webhook_not_registered' }),
        detail: {
          registered,
          pending: typeof info?.pending_update_count === 'number' ? info.pending_update_count : null,
          lastError: typeof info?.last_error_date === 'number',
        },
      }
    }),
  )
  return checks
}

export const telegramWebhookUrl = (publicUrl: string) => `${publicUrl}/api/webhooks/telegram`

/** Registers the Telegram webhook with the saved token and secret (`setWebhook`). */
export async function registerTelegramWebhook(ctx: TestContext): Promise<SettingsTestCheck> {
  const token = ctx.get('telegram.botToken')
  const secret = ctx.get('telegram.webhookSecret')
  if (!token || !secret) return notConfigured('webhook')
  return check('webhook', async () => {
    const res = await safeFetch(`${ctx.get('telegram.apiUrl')}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: telegramWebhookUrl(ctx.get('org.publicUrl') ?? ''),
        secret_token: secret,
        allowed_updates: ['message', 'my_chat_member'],
        drop_pending_updates: true,
      }),
      policy: ctx.policy,
    })
    if (res.status === 401 || res.status === 404) fail('auth_rejected')
    expectOk(res)
    if ((json(res) as { ok?: unknown } | null)?.ok !== true) fail('rejected')
  })
}

async function gitlab(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const url = ctx.get('gitlab.url')
  if (!url) return [notConfigured('user')]
  const token = ctx.get('gitlab.token')
  if (!token) return [secretMissing('user')]
  const headers = { 'PRIVATE-TOKEN': token, accept: 'application/json' }
  const checks = [
    await check('user', async () => {
      const res = await safeFetch(`${url}/api/v4/user`, { headers, policy: ctx.policy })
      expectOk(res)
      const username = (json(res) as { username?: unknown } | null)?.username
      return { ok: true, detail: { username: typeof username === 'string' ? username.slice(0, 64) : null } }
    }),
  ]
  if (!checks[0]!.ok) return checks
  checks.push(
    await check('scopes', async () => {
      const res = await safeFetch(`${url}/api/v4/personal_access_tokens/self`, { headers, policy: ctx.policy })
      // Older GitLab, or a token type without the endpoint: the scopes are unknown, not wrong.
      if (res.status === 404) return { ok: true, detail: { scopes: null, expiresAt: null } }
      expectOk(res)
      const t = json(res) as { scopes?: unknown; expires_at?: unknown } | null
      const scopes = Array.isArray(t?.scopes) ? t.scopes.filter((s): s is string => typeof s === 'string').slice(0, 20) : []
      const expiresAt = typeof t?.expires_at === 'string' ? t.expires_at.slice(0, 32) : null
      const ok = scopes.includes('api')
      return { ok, ...(ok ? {} : { code: 'missing_scope' }), detail: { scopes, expiresAt } }
    }),
  )
  return checks
}

async function ai(ctx: TestContext): Promise<SettingsTestCheck[]> {
  const jobs = { draft: ctx.get('ai.modelDraft'), fast: ctx.get('ai.modelFast'), embed: ctx.get('ai.embeddingModel') }
  const used = new Set(Object.values(jobs).filter((m): m is string => !!m).map((m) => parseModelId(m).provider))
  const anthropicKey = ctx.get('ai.anthropicApiKey')
  const openaiKey = ctx.get('ai.openaiApiKey')
  if (anthropicKey) used.add('anthropic')
  if (openaiKey) used.add('openai')
  const listed: Record<string, Set<string> | null> = {}
  const checks: SettingsTestCheck[] = []
  // The models endpoints cost nothing: no tokens are spent.
  if (used.has('anthropic')) {
    if (!anthropicKey) checks.push(secretMissing('anthropic'))
    else
      checks.push(
        await check('anthropic', async () => {
          const res = await safeFetch(`${ctx.anthropicUrl ?? 'https://api.anthropic.com'}/v1/models?limit=1000`, {
            headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            policy: ctx.policy,
            maxBytes: 256 * 1024,
          })
          expectOk(res)
          listed.anthropic = modelIds(json(res))
          return { ok: true, detail: { models: listed.anthropic.size } }
        }),
      )
  }
  if (used.has('openai')) {
    if (!openaiKey) checks.push(secretMissing('openai'))
    else
      checks.push(
        await check('openai', async () => {
          const base = ctx.get('ai.openaiBaseUrl') ?? 'https://api.openai.com/v1'
          const res = await safeFetch(`${base}/models`, { headers: { authorization: `Bearer ${openaiKey}` }, policy: ctx.policy, maxBytes: 256 * 1024 })
          expectOk(res)
          listed.openai = modelIds(json(res))
          return { ok: true, detail: { models: listed.openai.size } }
        }),
      )
  }
  for (const [job, spec] of Object.entries(jobs)) {
    if (!spec) continue
    const { provider, model } = parseModelId(spec)
    checks.push(
      await check(`model.${job}`, async () => {
        if (job === 'embed' && provider === 'anthropic') fail('no_embeddings')
        const ids = listed[provider]
        if (ids === undefined) fail('provider_unavailable')
        if (ids && ids.size && !ids.has(model)) fail('model_not_found', { priced: isPriced(model) })
        return { ok: true, detail: { priced: isPriced(model) } }
      }),
    )
  }
  if (!checks.length) return [notConfigured('models')]
  return checks
}

function modelIds(body: unknown): Set<string> {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return fail('invalid_response')
  return new Set(data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string'))
}

async function backup(ctx: TestContext): Promise<SettingsTestCheck[]> {
  return [
    await check('config', async () => {
      for (const key of ['backup.at', 'backup.keepDays'] as const) {
        if (!settingDef(key).schema.safeParse(ctx.get(key)).success) fail('invalid_config')
      }
    }),
  ]
}

async function storage(ctx: TestContext): Promise<SettingsTestCheck[]> {
  if (!ctx.storage) return [notConfigured('bucket')]
  return [
    await check('bucket', async () => {
      try {
        // HEAD bucket: read-only.
        await ctx.storage!.ping()
      } catch {
        fail('unreachable')
      }
    }),
  ]
}

const ACTIONS: Record<SettingsTestAction, (ctx: TestContext) => Promise<SettingsTestCheck[]>> = {
  oidc,
  smtp,
  line,
  telegram,
  gitlab,
  ai,
  backup,
  storage,
}

export async function runSettingsTest(action: SettingsTestAction, ctx: TestContext): Promise<SettingsTestResult> {
  const checks = await ACTIONS[action](ctx)
  return { action, ok: checks.length > 0 && checks.every((c) => c.ok), checks }
}
