// A stub Yoda for the extension's e2e (plan B12): the endpoints the extension calls, each request validated with
// the shared zod schemas (400 with the issues otherwise), and every report it receives kept for the test.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { chromiumappRedirect, DefectReportCreate, ExtensionAuthorize, ExtensionTokenRequest, type ExtensionMappings, type MappingRule } from '@yoda/shared'

export type ReceivedFile = { part: string; name: string; type: string; bytes: Buffer }
export type Received = { report: DefectReportCreate; files: ReceivedFile[]; idempotencyKey: string | null }

const PROJECT = '00000000-0000-4000-8000-000000000001'
const PERSON = { id: '00000000-0000-4000-8000-000000000002', displayName: 'คุณทดสอบ', isStaff: true }
const token = (p: string) => `${p}${randomBytes(32).toString('base64url')}`

export class StubYoda {
  readonly reports: Received[] = []
  readonly codes = new Map<string, { challenge: string; ext: string }>()
  readonly access = new Set<string>()
  readonly refresh = new Set<string>()
  rules: MappingRule[] = []
  private server: Server | null = null
  url = ''

  async start(port = 0): Promise<void> {
    this.server = createServer((q, r) => void this.handle(q, r).catch((e) => this.json(r, 500, { error: String(e) })))
    await new Promise<void>((res) => this.server!.listen(port, '127.0.0.1', () => res()))
    const addr = this.server.address() as { port: number }
    this.url = `http://localhost:${addr.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => {
      if (!this.server) return res()
      this.server.close(() => res())
      this.server.closeAllConnections()
    })
  }

  private json(r: ServerResponse, status: number, body: unknown): void {
    r.writeHead(status, { 'content-type': 'application/json' })
    r.end(JSON.stringify(body))
  }

  private async body(q: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const c of q) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  private bearer(q: IncomingMessage): boolean {
    const a = q.headers.authorization ?? ''
    return a.startsWith('Bearer ') && this.access.has(a.slice(7))
  }

  private tokens() {
    const accessToken = token('yoda_xt_')
    const refreshToken = token('yoda_xr_')
    this.access.add(accessToken)
    this.refresh.add(refreshToken)
    return { accessToken, expiresIn: 3600, refreshToken, grantId: '00000000-0000-4000-8000-000000000003', person: PERSON }
  }

  private async handle(q: IncomingMessage, r: ServerResponse): Promise<void> {
    const url = new URL(q.url ?? '/', this.url)
    const path = url.pathname
    if (process.env.STUB_LOG) (await import("node:fs")).appendFileSync(process.env.STUB_LOG, `${q.method} ${path}\n`)
    if (path === '/api/public-config') {
      return this.json(r, 200, {
        oidc: null,
        org: { name: 'Yoda ทดสอบ', nameEn: 'Test Yoda', line: null, defaultLocale: 'th' },
        runnerDocsUrl: null,
        line: { addFriendUrl: null },
        funMode: false,
        setup: 'done',
        recovery: false,
        recoveryForced: false,
        version: '1.2.0',
        extension: { enabled: true, apiVersion: 1 },
      })
    }
    if (path === '/approve') return this.json(r, 200, {})
    if (path === '/extension/connect') {
      // The approve page: Approve mints a code for the extension's own redirect, as the portal does.
      const parsed = ExtensionAuthorize.safeParse({
        extensionId: url.searchParams.get('ext'),
        redirectUri: url.searchParams.get('redirect_uri'),
        codeChallenge: url.searchParams.get('code_challenge'),
        codeChallengeMethod: 'S256',
        state: url.searchParams.get('state'),
        browserLabel: url.searchParams.get('browser') || 'x',
      })
      if (!parsed.success || parsed.data.redirectUri !== chromiumappRedirect(parsed.data.extensionId)) {
        r.writeHead(400, { 'content-type': 'text/html' })
        return void r.end('<p data-testid="connect-error">bad request</p>')
      }
      const code = token('yoda_xc_')
      this.codes.set(code, { challenge: parsed.data.codeChallenge, ext: parsed.data.extensionId })
      const to = `${parsed.data.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(parsed.data.state)}`
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return void r.end(`<!doctype html><title>Approve</title><h1>Connect Yoda Reporter</h1><button data-testid="connect-approve" onclick="fetch('/approve').then(() => location.replace(${JSON.stringify(to).replace(/"/g, '&quot;')}))">Approve</button>`)
    }
    if (path === '/api/extension/token' && q.method === 'POST') {
      const parsed = ExtensionTokenRequest.safeParse(JSON.parse((await this.body(q)).toString() || '{}'))
      if (!parsed.success) return this.json(r, 400, { error: 'validation', issues: parsed.error.issues })
      if (parsed.data.grantType === 'authorization_code') {
        const c = this.codes.get(parsed.data.code)
        this.codes.delete(parsed.data.code)
        const { createHash } = await import('node:crypto')
        if (!c || c.ext !== parsed.data.extensionId || createHash('sha256').update(parsed.data.codeVerifier).digest('base64url') !== c.challenge) return this.json(r, 401, { error: 'unauthorized', reason: 'invalid_grant' })
        return this.json(r, 200, this.tokens())
      }
      if (!this.refresh.delete(parsed.data.refreshToken)) return this.json(r, 401, { error: 'unauthorized', reason: 'revoked' })
      return this.json(r, 200, this.tokens())
    }
    if (!path.startsWith('/api/extension/')) return this.json(r, 404, { error: 'not_found' })
    if (!this.bearer(q)) return this.json(r, 401, { error: 'unauthorized' })
    if (path === '/api/extension/session') {
      const perRole = { screenshot: 10485760, screenshot_full: 15728640, video: 26214400, buffer: 26214400, console: 1048576, network: 1048576 }
      return this.json(r, 200, {
        apiVersion: 1,
        instance: { name: { th: 'Yoda ทดสอบ', en: 'Test Yoda' }, publicUrl: this.url, version: '1.2.0' },
        latestExtension: null,
        person: PERSON,
        projects: [{ id: PROJECT, name: 'ระบบนัดหมาย OPD', noAi: false, kinds: ['defect', 'bug_fix_request'], repos: ['demo/app'] }],
        limits: { maxFileBytes: 26214400, maxReportBytes: 52428800, maxFiles: 8, maxVideoSeconds: 30, perRole, allowedTypes: { screenshot: ['image/png'], screenshot_full: ['image/png'], video: ['video/webm'], buffer: ['video/webm'], console: ['application/json'], network: ['application/json'] } },
        policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true },
      })
    }
    if (path === '/api/extension/mappings') return this.json(r, 200, { rules: this.rules, ttlSeconds: 600 } satisfies ExtensionMappings)
    if (path === '/api/extension/revoke') {
      this.access.clear()
      r.writeHead(204)
      return void r.end()
    }
    if (path === '/api/extension/defects' && q.method === 'POST') {
      const raw = await this.body(q)
      const form = await new Request(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': q.headers['content-type'] ?? '' }, body: new Uint8Array(raw) }).formData()
      const first = [...form.keys()][0]
      if (first !== 'report') return this.json(r, 400, { error: 'validation', issues: [{ message: 'report must be first' }] })
      const parsed = DefectReportCreate.safeParse(JSON.parse(String(form.get('report'))))
      if (!parsed.success) return this.json(r, 400, { error: 'validation', issues: parsed.error.issues })
      const files: ReceivedFile[] = []
      for (const a of parsed.data.attachments) {
        const f = form.get(a.part)
        if (!(f instanceof Blob)) return this.json(r, 400, { error: 'validation', issues: [{ message: `missing ${a.part}` }] })
        const bytes = Buffer.from(await f.arrayBuffer())
        if (bytes.length !== a.sizeBytes || (f.type || a.type) !== a.type) return this.json(r, 400, { error: 'validation', issues: [{ message: `${a.part} differs from its declaration` }] })
        files.push({ part: a.part, name: a.name, type: a.type, bytes })
      }
      this.reports.push({ report: parsed.data, files, idempotencyKey: (q.headers['idempotency-key'] as string) ?? null })
      const id = randomUUID()
      return this.json(r, 201, { workItemId: id, url: `${this.url}/work-items/${id}`, title: parsed.data.title, stepKey: 'triage', state: 'active', aiAllowed: !parsed.data.privacy.textMayContainPatientData, attachments: [] })
    }
    return this.json(r, 404, { error: 'not_found' })
  }
}
