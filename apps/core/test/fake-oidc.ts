import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { signToken, testJwksDocument } from './jwt.js'

/**
 * A Keycloak-shaped OIDC provider on 127.0.0.1 for the /recovery test sign-in: discovery, the token endpoint
 * (authorization code + PKCE S256) and the JWKS of the test key (test/jwt.ts). `authorize(url)` plays the browser
 * and the sign-in page: it reads the authorization URL core built and returns the code and state the provider
 * would send back to /recovery.
 */
export type FakeOidcUser = { username: string; groups?: string[] | null; sub?: string }

type Grant = { clientId: string; redirectUri: string; challenge: string; nonce: string; user: FakeOidcUser }

export class FakeOidc {
  private server: Server | null = null
  private grants = new Map<string, Grant>()
  /** Overrides for the next tokens (a wrong azp, another issuer, a missing nonce...). */
  tamper: { idToken?: Record<string, unknown>; accessToken?: Record<string, unknown> } = {}
  tokenRequests = 0
  base = ''

  get issuer(): string {
    return `${this.base}/realms/test`
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => void this.handle(req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks).toString(), res))
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  /** The sign-in page: accepts the authorization request and returns what the redirect to /recovery carries. */
  authorize(authorizeUrl: string, user: FakeOidcUser): { code: string; state: string } {
    const u = new URL(authorizeUrl)
    const p = u.searchParams
    if (p.get('code_challenge_method') !== 'S256' || p.get('response_type') !== 'code') throw new Error('not a PKCE code request')
    const code = randomBytes(16).toString('hex')
    this.grants.set(code, { clientId: p.get('client_id')!, redirectUri: p.get('redirect_uri')!, challenge: p.get('code_challenge')!, nonce: p.get('nonce')!, user })
    return { code, state: p.get('state')! }
  }

  private async handle(method: string, url: string, body: string, res: import('node:http').ServerResponse): Promise<void> {
    const path = url.split('?')[0]
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (path === '/realms/test/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
        jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
      })
    }
    if (path === '/realms/test/protocol/openid-connect/certs') return json(200, await testJwksDocument())
    if (path === '/realms/test/protocol/openid-connect/auth') {
      // The client check of the settings test (no client errors for the known client).
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>sign in</html>')
      return
    }
    if (path === '/realms/test/protocol/openid-connect/token' && method === 'POST') {
      this.tokenRequests++
      const p = new URLSearchParams(body)
      const grant = this.grants.get(p.get('code') ?? '')
      this.grants.delete(p.get('code') ?? '')
      const verifier = p.get('code_verifier') ?? ''
      if (
        !grant ||
        p.get('grant_type') !== 'authorization_code' ||
        p.get('client_id') !== grant.clientId ||
        p.get('redirect_uri') !== grant.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
      ) {
        return json(400, { error: 'invalid_grant' })
      }
      const sub = grant.user.sub ?? `sub-${grant.user.username}`
      const groups = grant.user.groups === null ? {} : { groups: grant.user.groups ?? ['/it-dev'] }
      const idToken = await signToken({ iss: this.issuer, aud: grant.clientId, azp: grant.clientId, sub, nonce: grant.nonce, typ: 'ID', preferred_username: grant.user.username, ...this.tamper.idToken })
      const accessToken = await signToken({ iss: this.issuer, azp: grant.clientId, sub, typ: 'Bearer', preferred_username: grant.user.username, ...groups, ...this.tamper.accessToken })
      return json(200, { access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: 300 })
    }
    json(404, { error: 'not_found' })
  }
}

export async function startFakeOidc(): Promise<FakeOidc> {
  const f = new FakeOidc()
  await f.start()
  return f
}
