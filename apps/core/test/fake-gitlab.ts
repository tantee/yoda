import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeRequest = { method: string; path: string; body: unknown }
type Project = { id: number; path_with_namespace: string; web_url: string; default_branch: string | null }
/** `byBot`: created through the API (i.e. by the token's user), as `scope=created_by_me` sees it. */
type Issue = { iid: number; title: string; description: string; web_url: string; state: string; byBot: boolean }
type Send = (status: number, data?: unknown) => void
export type FakeMergeRequest = { project_id: number; iid: number; title: string; web_url: string; state: string; source_branch: string; description: string }

/** GitLab's basic search splits on non-alphanumerics and needs every term (here: as a whole word). */
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const searchHit = (q: string, i: Issue) => {
  const terms = words(q)
  const have = new Set(words(`${i.title} ${i.description}`))
  return terms.length > 0 && terms.every((t) => have.has(t))
}

/** In-memory GitLab REST v4 stand-in for tests. The token is only checked, never stored. */
export class FakeGitLab {
  readonly requests: FakeRequest[] = []
  readonly projects: Project[] = []
  readonly issues = new Map<number, Issue[]>()
  readonly notes = new Map<string, string[]>()
  /** Related merge requests by `<projectId>/<issueIid>`. */
  readonly related = new Map<string, FakeMergeRequest[]>()
  /** MRs opened through the API, by project. */
  readonly mergeRequests = new Map<number, (FakeMergeRequest & { target_branch: string; remove_source_branch: boolean })[]>()
  /** Branches that exist (were pushed), by project; MRs can only be opened from these. */
  readonly branches = new Map<number, Set<string>>()
  /** DEV ONLY (fake-gitlab-dev): the fake hosts no git, so treat every source branch as pushed. */
  acceptAnyBranch = false
  private readonly nextIid = new Map<number, number>()
  private readonly nextMrIid = new Map<number, number>()
  private server: Server | null = null
  private fails: { status: number; count: number; retryAfter?: number } | null = null
  private delay: { ms: number; count: number } | null = null
  private token: string | null = null
  url = ''

  addProject(path: string, id = this.projects.length + 1, defaultBranch: string | null = 'main'): Project {
    const p = { id, path_with_namespace: path, web_url: `${this.url}/${path}`, default_branch: defaultBranch }
    this.projects.push(p)
    this.issues.set(id, [])
    return p
  }
  seedIssue(projectId: number, input: { title: string; description: string; byBot?: boolean }): Issue {
    const project = this.projects.find((p) => p.id === projectId)!
    const iid = (this.nextIid.get(projectId) ?? 0) + 1
    this.nextIid.set(projectId, iid)
    const issue = { iid, title: input.title, description: input.description, web_url: `${project.web_url}/-/issues/${iid}`, state: 'opened', byBot: input.byBot ?? false }
    this.issues.get(projectId)!.push(issue)
    return issue
  }
  /** An MR GitLab lists under the issue's related merge requests (as closing or mentioning it). */
  relateMergeRequest(projectId: number, issueIid: number, mr: Omit<FakeMergeRequest, 'project_id' | 'web_url'> & { project_id?: number }): FakeMergeRequest {
    const pid = mr.project_id ?? projectId
    const project = this.projects.find((p) => p.id === pid)!
    const k = `${projectId}/${issueIid}`
    const list = (this.related.get(k) ?? []).filter((m) => !(m.project_id === pid && m.iid === mr.iid))
    const full = { ...mr, project_id: pid, web_url: `${project.web_url}/-/merge_requests/${mr.iid}` }
    this.related.set(k, [...list, full])
    return full
  }
  /** Makes a branch exist in the project, as a runner's push would. */
  pushBranch(projectId: number, branch: string) {
    this.branches.set(projectId, (this.branches.get(projectId) ?? new Set()).add(branch))
  }
  failNext(status: number, count = 1, retryAfterSecs?: number) { this.fails = { status, count, retryAfter: retryAfterSecs } }
  delayNext(ms: number, count = 1) { this.delay = { ms, count } }
  requireToken(token: string | null) { this.token = token }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => void this.handle(req.method ?? 'GET', req.url ?? '/', req.headers['private-token'], Buffer.concat(chunks).toString(), res))
    })
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  /** `GET` (by `source_branch` / `state`) and `POST /projects/:id/merge_requests`, with GitLab's 409 for a duplicate. */
  private handleMergeRequests(project: Project, method: string, rawUrl: string, body: unknown, send: Send) {
    const list = this.mergeRequests.get(project.id) ?? []
    if (method === 'GET') {
      const params = new URL(rawUrl, 'http://x').searchParams
      const branch = params.get('source_branch')
      const state = params.get('state')
      return send(200, list.filter((m) => (branch === null || m.source_branch === branch) && (state === null || state === 'all' || m.state === state)))
    }
    if (method !== 'POST') return send(404, { message: '404 Not Found' })
    const b = (body ?? {}) as { source_branch?: string; target_branch?: string; title?: string; description?: string; remove_source_branch?: boolean }
    if (!b.title || !b.source_branch || !b.target_branch) return send(400, { message: 'source_branch, target_branch and title are required' })
    if (!this.acceptAnyBranch && !this.branches.get(project.id)?.has(b.source_branch)) return send(400, { message: 'Source branch does not exist' })
    const dup = list.find((m) => m.source_branch === b.source_branch && m.state === 'opened')
    if (dup) return send(409, { message: [`Another open merge request already exists for this source branch: !${dup.iid}`] })
    const iid = (this.nextMrIid.get(project.id) ?? 0) + 1
    this.nextMrIid.set(project.id, iid)
    const mr = {
      project_id: project.id,
      iid,
      title: b.title,
      web_url: `${project.web_url}/-/merge_requests/${iid}`,
      state: 'opened',
      source_branch: b.source_branch,
      target_branch: b.target_branch,
      description: b.description ?? '',
      remove_source_branch: b.remove_source_branch ?? false,
    }
    this.mergeRequests.set(project.id, [...list, mr])
    return send(201, mr)
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
    if (parts[2] === 'merge_requests' && parts.length === 3) return this.handleMergeRequests(project, method, rawUrl, body, send)
    if (parts[2] !== 'issues') return send(404, { message: '404 Not Found' })
    const list = this.issues.get(project.id)!
    const b = (body ?? {}) as { title?: string; description?: string; body?: string }
    const pub = ({ byBot: _, ...i }: Issue) => i
    if (parts.length === 3 && method === 'GET') {
      const params = new URL(rawUrl, 'http://x').searchParams
      const q = params.get('search')
      let hits = list.filter((i) => (q === null || searchHit(q, i)) && (params.get('scope') !== 'created_by_me' || i.byBot))
      if (params.get('sort') !== 'asc') hits = [...hits].reverse()
      return send(200, hits.slice(0, Number(params.get('per_page') ?? 20)).map(pub))
    }
    if (parts.length === 3 && method === 'POST') {
      if (!b.title) return send(400, { message: 'title is missing' })
      return send(201, pub(this.seedIssue(project.id, { title: b.title, description: b.description ?? '', byBot: true })))
    }
    const issue = list.find((i) => String(i.iid) === parts[3])
    if (!issue) return send(404, { message: '404 Not Found' })
    if (parts.length === 4 && method === 'GET') return send(200, pub(issue))
    if (parts.length === 4 && method === 'PUT') {
      if (b.description !== undefined) issue.description = b.description
      return send(200, pub(issue))
    }
    if (parts.length === 5 && parts[4] === 'related_merge_requests' && method === 'GET') {
      return send(200, this.related.get(`${project.id}/${issue.iid}`) ?? [])
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
