const CODES: Record<string, string> = {
  invalid_state: 'errors.invalidState',
  not_member: 'errors.notMember',
  decision_required: 'errors.decisionRequired',
  comment_required: 'errors.commentRequired',
  project_required: 'errors.projectRequired',
  gitlab_not_connected: 'errors.gitlabNotConnected',
  repo_not_found: 'errors.repoNotFound',
  issue_not_found: 'errors.issueNotFound',
  gitlab_unavailable: 'errors.gitlabUnavailable',
  invalid_prefs: 'errors.invalidPrefs',
  channel_not_configured: 'errors.channelNotConfigured',
}

export function errorKey(e: unknown): string {
  const err = e as {
    statusCode?: number
    status?: number
    response?: { status?: number }
    data?: { error?: string }
  }
  const code = err?.data?.error
  if (code && CODES[code]) return CODES[code]
  const status = err?.statusCode ?? err?.status ?? err?.response?.status
  if (status === 403) return 'errors.forbidden'
  if (status === 404) return 'errors.notFound'
  return 'errors.generic'
}
