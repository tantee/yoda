import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeRequest = { method: string; path: string; body: unknown }
type Project = { id: number; path_with_namespace: string; web_url: string; default_branch: string }
type Issue = { iid: number; title: string; description: string; web_url: string; state: string }

/** In-memory GitLab REST v4 stand-in for tests. The token is only checked, never stored. */
export class FakeGitLab {
  readonly requests: FakeRequest[] = []
  readonly projects: Project[] = []
  readonly issues = new Map<number, Issue[]>()
  readonly notes = new Map<string, string[]>()
  private readonly nextIid = new Map<number, number>()
  private server: Server | null = null
  private fails: { status: number; count: number; retryAfter?: number } | null = null
  private delay: { ms: number; count: number } | null = null
  private token: string | null = null
  url = ''

  addProject(path: string, id = this.projects.length + 1): Project {
    const p = { id, path_with_namespace: path, web_url: `${this.url}/${path}`, default_branch: 'main' }
    this.projects.push(p)
    this.issues.set(id, [])
    return p
  }
  seedIssue(projectId: number, input: { title: string; description: string }): Issue {
    const project = this.projects.find((p) => p.id === projectId)!
    const iid = (this.nextIid.get(projectId) ?? 0) + 1
    this.nextIid.set(projectId, iid)
    const issue = { iid, title: input.title, description: input.description, web_url: `${project.web_url}/-/issues/${iid}`, state: 'opened' }
    this.issues.get(projectId)!.push(issue)
    return issue
  }
  failNext(status: number, count = 1, retryAfterSecs?: number) { this.fails = { status, count, retryAfter: retryAfterSecs } }
  delayNext(ms: number, count = 1) { this.delay = { ms, count } }
  requireToken(token: string | null) { this.token = token }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => void this.handle(req.method ?? 'GET', req.url ?? '/', req.headers['private-token'], Buffer.concat(chunks).toString(), res))
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  private async handle(method: string, rawUrl: string, tokenHeader: string | string[] | undefined, raw: string, res: import('node:http').ServerResponse) {
    let body: unknown
    try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
    const path = rawUrl.split('?')[0]!
    this.requests.push({ method, path, body })
    const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(data === undefined ? '' : JSON.stringify(data))
    }
    if (this.delay && this.delay.count > 0) {
      this.delay.count--
      await new Promise((r) => setTimeout(r, this.delay!.ms))
    }
    if (this.token !== null && tokenHeader !== this.token) return send(401, { message: '401 Unauthorized' })
    if (this.fails && this.fails.count > 0) {
      this.fails.count--
      return send(this.fails.status, { message: 'injected failure' }, this.fails.retryAfter === undefined ? {} : { 'retry-after': String(this.fails.retryAfter) })
    }
    const m = path.match(/^\/api\/v4\/(.*)$/)
    if (!m) return send(404, { message: '404 Not Found' })
    const parts = m[1]!.split('/')
    if (method === 'GET' && parts[0] === 'user') return send(200, { id: 1, username: 'yoda-bot' })
    if (parts[0] !== 'projects' || !parts[1]) return send(404, { message: '404 Not Found' })
    const key = decodeURIComponent(parts[1])
    const project = this.projects.find((p) => String(p.id) === key || p.path_with_namespace === key)
    if (!project) return send(404, { message: '404 Project Not Found' })
    if (parts.length === 2 && method === 'GET') return send(200, project)
    if (parts[2] !== 'issues') return send(404, { message: '404 Not Found' })
    const list = this.issues.get(project.id)!
    const b = (body ?? {}) as { title?: string; description?: string; body?: string }
    if (parts.length === 3 && method === 'GET') {
      const q = new URL(rawUrl, 'http://x').searchParams.get('search') ?? ''
      return send(200, list.filter((i) => i.description.includes(q) || i.title.includes(q)))
    }
    if (parts.length === 3 && method === 'POST') {
      if (!b.title) return send(400, { message: 'title is missing' })
      return send(201, this.seedIssue(project.id, { title: b.title, description: b.description ?? '' }))
    }
    const issue = list.find((i) => String(i.iid) === parts[3])
    if (!issue) return send(404, { message: '404 Not Found' })
    if (parts.length === 4 && method === 'GET') return send(200, issue)
    if (parts.length === 4 && method === 'PUT') {
      if (b.description !== undefined) issue.description = b.description
      return send(200, issue)
    }
    if (parts.length === 5 && parts[4] === 'notes' && method === 'POST') {
      const k = `${project.id}/${issue.iid}`
      this.notes.set(k, [...(this.notes.get(k) ?? []), b.body ?? ''])
      return send(201, { id: 1, body: b.body })
    }
    return send(404, { message: '404 Not Found' })
  }
}

export async function startFakeGitLab(): Promise<FakeGitLab> {
  const f = new FakeGitLab()
  await f.start()
  return f
}
