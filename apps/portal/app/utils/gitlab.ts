import type { IssueSyncStatus } from '@yoda/shared'

export function syncStatusKey(s: IssueSyncStatus): string {
  return `gitlab.sync.${s}`
}

/** The text a developer puts in a merge request description so GitLab links (and closes) the issue. */
export function closesHint(issueIid: number | null): string | null {
  return issueIid === null ? null : `Closes #${issueIid}`
}
