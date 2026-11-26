import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type LineRequest = { method: string; path: string; authorization: string | undefined; body: unknown }
type LineText = { type: string; text: string }

/** `X-Line-Signature` for a webhook body: base64 HMAC-SHA256 keyed by the channel secret. */
export const lineSignature = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64')

/** In-memory LINE Messaging API stand-in (push and reply). The token is only checked, never stored. */
export class FakeLine {
  readonly requests: LineRequest[] = []
  private server: Server | null = null
  private fails: { status: number; count: number } | null = null
  private token: string | null = null
  url = ''

  /** Messages pushed to a user: `{ to, text }`. */
  get pushes(): { to: string; text: string }[] {
    return this.requests
      .filter((r) => r.path === '/v2/bot/message/push')
      .map((r) => {
        const b = r.body as { to: string; messages: LineText[] }
        return { to: b.to, text: b.messages.map((m) => m.text).join('\n') }
      })
  }
  /** Replies to a webhook event: `{ replyToken, text }`. */
  get replies(): { replyToken: string; text: string }[] {
    return this.requests
      .filter((r) => r.path === '/v2/bot/message/reply')
      .map((r) => {
        const b = r.body as { replyToken: string; messages: LineText[] }
        return { replyToken: b.replyToken, text: b.messages.map((m) => m.text).join('\n') }
      })
  }

  failNext(status: number, count = 1) { this.fails = { status, count } }
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
        this.requests.push({ method: req.method ?? 'GET', path, authorization: req.headers.authorization, body })
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(data))
        }
        if (this.token !== null && req.headers.authorization !== `Bearer ${this.token}`) return send(401, { message: 'Authentication failed' })
        if (this.fails && this.fails.count > 0) {
          this.fails.count--
          return send(this.fails.status, { message: 'injected failure' })
        }
        if (req.method === 'GET' && path === '/v2/bot/info') return send(200, { userId: 'U0000', basicId: '@yoda-test', displayName: 'Yoda' })
        if (req.method !== 'POST' || (path !== '/v2/bot/message/push' && path !== '/v2/bot/message/reply')) return send(404, { message: 'Not found' })
        const b = (body ?? {}) as { messages?: LineText[] }
        if (!Array.isArray(b.messages) || b.messages.some((m) => m.type !== 'text' || m.text.length > 5000)) {
          return send(400, { message: 'The request body has 1 error(s)' })
        }
        return send(200, {})
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

export async function startFakeLine(): Promise<FakeLine> {
  const f = new FakeLine()
  await f.start()
  return f
}
