import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type TelegramRequest = { method: string; path: string; body: unknown }

/** In-memory Telegram Bot API stand-in (`sendMessage`). The token (in the URL path) is only checked. */
export class FakeTelegram {
  readonly requests: TelegramRequest[] = []
  private server: Server | null = null
  private fails: { status: number; count: number; description: string } | null = null
  private token: string | null = null
  url = ''
  /** What `getMe` answers. */
  username = 'yoda_test_bot'
  /** The last `setWebhook` body. */
  webhook: { url: string; secret_token?: string; drop_pending_updates?: boolean } | null = null

  /** Messages sent through `sendMessage`: `{ chatId, text }`. */
  get messages(): { chatId: string; text: string; parseMode?: string }[] {
    return this.requests
      .filter((r) => r.path.endsWith('/sendMessage'))
      .map((r) => {
        const b = r.body as { chat_id: string | number; text: string; parse_mode?: string }
        return { chatId: String(b.chat_id), text: b.text, parseMode: b.parse_mode }
      })
  }

  /** The next `count` calls answer `status` with Telegram's error shape and this description. */
  failNext(status: number, count = 1, description = 'injected failure') { this.fails = { status, count, description } }
  requireToken(token: string | null) { this.token = token }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let body: unknown
        try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
        const path = (req.url ?? '/').split('?')[0]!
        this.requests.push({ method: req.method ?? 'GET', path, body })
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(data))
        }
        const m = path.match(/^\/bot([^/]+)\/(\w+)$/)
        if (!m || (this.token !== null && m[1] !== this.token)) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' })
        if (this.fails && this.fails.count > 0) {
          this.fails.count--
          return send(this.fails.status, { ok: false, error_code: this.fails.status, description: this.fails.description })
        }
        // The settings test (getMe, getWebhookInfo) and webhook registration (setWebhook).
        if (m[2] === 'getMe') return send(200, { ok: true, result: { id: 1001, is_bot: true, first_name: 'Yoda', username: this.username } })
        if (m[2] === 'getWebhookInfo') return send(200, { ok: true, result: { url: this.webhook?.url ?? '', pending_update_count: 0 } })
        if (m[2] === 'setWebhook' && req.method === 'POST') {
          this.webhook = body as NonNullable<FakeTelegram['webhook']>
          return send(200, { ok: true, result: true, description: 'Webhook was set' })
        }
        if (req.method !== 'POST' || m[2] !== 'sendMessage') return send(404, { ok: false, error_code: 404, description: 'Not Found' })
        const b = (body ?? {}) as { chat_id?: unknown; text?: string }
        if (b.chat_id === undefined || !b.text || b.text.length > 4096) return send(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' })
        return send(200, { ok: true, result: { message_id: this.requests.length, text: b.text } })
      })
    })
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const f = new FakeTelegram()
  await f.start()
  return f
}
