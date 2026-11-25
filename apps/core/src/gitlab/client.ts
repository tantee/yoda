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

export class GitLabClient {
  private readonly api: string
  private readonly token: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly retryBaseMs: number

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
      if (code === 'unavailable' && attempt < MAX_RETRIES) {
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

  currentUser(): Promise<{ id: number; username: string }> {
    return this.request('GET', '/user')
  }

  getProject(pathOrId: string | number): Promise<{ id: number; path_with_namespace: string; web_url: string; default_branch: string }> {
    return this.request('GET', `/projects/${this.proj(pathOrId)}`)
  }

  createIssue(projectId: number, input: { title: string; description: string }): Promise<{ iid: number; web_url: string; description: string }> {
    return this.request('POST', `/projects/${this.proj(projectId)}/issues`, input)
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

  async importIssue(projectId: number, iid: number): Promise<{ title: string; description: string; web_url: string; iid: number }> {
    const i = await this.request<{ title: string; description: string | null; web_url: string; iid: number }>(
      'GET',
      `/projects/${this.proj(projectId)}/issues/${iid}`,
    )
    return { title: i.title, description: i.description ?? '', web_url: i.web_url, iid: i.iid }
  }
}
