import type { IssueSyncStatus, MergeRequest } from '@yoda/shared'

const PIPELINE: Record<MergeRequest['pipeline'], string> = {
  success: 'success',
  failed: 'error',
  running: 'info',
  pending: 'warning',
  canceled: 'grey',
  none: 'grey',
}

export function pipelineColor(p: MergeRequest['pipeline']): string {
  return PIPELINE[p] ?? 'grey'
}

const MR_STATE: Record<MergeRequest['state'], string> = { merged: 'success', opened: 'info', closed: 'grey' }

export function mrStateColor(s: MergeRequest['state']): string {
  return MR_STATE[s] ?? 'grey'
}

export function syncStatusKey(s: IssueSyncStatus): string {
  return `gitlab.sync.${s}`
}

/** The text a developer puts in a merge request description so GitLab links (and closes) the issue. */
export function closesHint(issueIid: number | null): string | null {
  return issueIid === null ? null : `Closes #${issueIid}`
}
