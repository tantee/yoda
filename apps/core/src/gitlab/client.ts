export type GitLabErrorCode = 'not_found' | 'forbidden' | 'unavailable' | 'bad_request'

/** Thrown for every failed GitLab call. The message never contains the token or the request URL. */
export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: GitLabErrorCode,
  ) {
    super(message)
    this.name = 'GitLabError'
  }
}

export type GitLabClientOptions = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Base of the exponential backoff between retries (default 500 ms); tests lower it. */
  retryBaseMs?: number
}

const MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 30_000

function codeFor(status: number): GitLabErrorCode {
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429 || status >= 500) return 'unavailable'
  return 'bad_request'
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs < 0) return null
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type GitLabMergeRequest = {
  project_id: number
  iid: number
  title: string
  web_url: string
  state: string
  source_branch: string
  description: string
}

export class GitLabClient {
  private readonly api: string
  private readonly token: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly retryBaseMs: number
  /**
   * The bot user, once any `currentUser()` call has succeeded (at boot, or the admin status page). The webhook
   * reads only this cache and never calls GitLab itself.
   */
  botUser: { id: number; username: string } | null = null

  constructor(opts: GitLabClientOptions) {
    this.api = `${opts.baseUrl.replace(/\/+$/, '')}/api/v4`
    this.token = opts.token
    this.fetchFn = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.retryBaseMs = opts.retryBaseMs ?? 500
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.api}${path}`
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            'PRIVATE-TOKEN': this.token,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch {
        // Network failure or timeout: the underlying error may embed the URL, so it is dropped.
        res = null
      }
      if (res && res.ok) {
        if (res.status === 204) return undefined as T
        try {
          return (await res.json()) as T
        } catch {
          throw new GitLabError('GitLab returned an unreadable response', res.status, 'unavailable')
        }
      }
      const status = res ? res.status : null
      const code = status === null ? 'unavailable' : codeFor(status)
      // POST is not idempotent: a 5xx/timeout may have succeeded server-side, so only 429 (never processed) is retried.
      const retryable = method === 'POST' ? status === 429 : code === 'unavailable'
      if (retryable && attempt < MAX_RETRIES) {
        const wait = (res && retryAfterMs(res)) ?? this.retryBaseMs * 2 ** attempt
        await res?.body?.cancel().catch(() => {})
        await sleep(wait)
        continue
      }
      await res?.body?.cancel().catch(() => {})
      throw new GitLabError(
        status === null ? `GitLab ${method} request failed (network or timeout)` : `GitLab ${method} request failed with status ${status}`,
        status,
        code,
      )
    }
  }

  private proj(id: number | string): string {
    return encodeURIComponent(String(id))
  }

  async currentUser(): Promise<{ id: number; username: string }> {
    const u = await this.request<{ id: number; username: string }>('GET', '/user')
    this.botUser = { id: u.id, username: u.username }
    return u
  }

  getProject(pathOrId: string | number): Promise<{ id: number; path_with_namespace: string; web_url: string; default_branch: string | null }> {
    return this.request('GET', `/projects/${this.proj(pathOrId)}`)
  }

  createIssue(projectId: number, input: { title: string; description: string }): Promise<{ iid: number; web_url: string; description: string }> {
    return this.request('POST', `/projects/${this.proj(projectId)}/issues`, input)
  }

  /**
   * Opens an MR (a POST: retried only on 429). GitLab answers 409 when an open MR already exists for the source
   * branch; that MR is looked up and returned, so the call is idempotent.
   */
  async createMergeRequest(
    projectId: number,
    input: { sourceBranch: string; targetBranch: string; title: string; description: string; removeSourceBranch: true },
  ): Promise<{ iid: number; webUrl: string; state: string }> {
    type Mr = { iid: number; web_url: string; state: string }
    const base = `/projects/${this.proj(projectId)}/merge_requests`
    try {
      const mr = await this.request<Mr>('POST', base, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: input.removeSourceBranch,
      })
      return { iid: mr.iid, webUrl: mr.web_url, state: mr.state }
    } catch (err) {
      if (!(err instanceof GitLabError) || err.status !== 409) throw err
      const open = await this.request<Mr[]>('GET', `${base}?source_branch=${encodeURIComponent(input.sourceBranch)}&state=opened&per_page=1`)
      const mr = open[0]
      if (!mr) throw err
      return { iid: mr.iid, webUrl: mr.web_url, state: mr.state }
    }
  }

  getIssue(projectId: number, iid: number): Promise<{ iid: number; description: string; web_url: string; state: string }> {
    return this.request('GET', `/projects/${this.proj(projectId)}/issues/${iid}`)
  }

  async updateIssue(projectId: number, iid: number, input: { description: string }): Promise<void> {
    await this.request('PUT', `/projects/${this.proj(projectId)}/issues/${iid}`, input)
  }

  async addIssueNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.request('POST', `/projects/${this.proj(projectId)}/issues/${iid}/notes`, { body })
  }

  /**
   * Finds an issue whose description contains `q.contains`: GitLab's word search for `q.search` (a single
   * alphanumeric word, see `markerQuery`), then the bot's 50 most recent issues in the project (older markers
   * have no searchable word, and search indexes may lag). Matches are always confirmed in the body.
   */
  async findIssueByMarker(projectId: number, q: { search: string; contains: string }): Promise<{ iid: number; web_url: string; description: string } | null> {
    type Hit = { iid: number; web_url: string; description: string | null }
    const pick = (list: Hit[]) => {
      const hit = list.find((i) => (i.description ?? '').includes(q.contains))
      return hit ? { iid: hit.iid, web_url: hit.web_url, description: hit.description ?? '' } : null
    }
    const issues = `/projects/${this.proj(projectId)}/issues`
    const found = pick(await this.request<Hit[]>('GET', `${issues}?search=${encodeURIComponent(q.search)}&in=description&per_page=20`))
    if (found) return found
    return pick(await this.request<Hit[]>('GET', `${issues}?scope=created_by_me&order_by=created_at&sort=desc&per_page=50`))
  }

  /** Merge requests GitLab relates to the issue (closing or mentioning it), from any project the bot can see. */
  async relatedMergeRequests(projectId: number, iid: number): Promise<GitLabMergeRequest[]> {
    const list = await this.request<(Omit<GitLabMergeRequest, 'description'> & { description: string | null })[]>(
      'GET',
      `/projects/${this.proj(projectId)}/issues/${iid}/related_merge_requests?per_page=100`,
    )
    return list.map((m) => ({ ...m, description: m.description ?? '' }))
  }

  async importIssue(projectId: number, iid: number): Promise<{ title: string; description: string; web_url: string; iid: number }> {
    const i = await this.request<{ title: string; description: string | null; web_url: string; iid: number }>(
      'GET',
      `/projects/${this.proj(projectId)}/issues/${iid}`,
    )
    return { title: i.title, description: i.description ?? '', web_url: i.web_url, iid: i.iid }
  }
}
