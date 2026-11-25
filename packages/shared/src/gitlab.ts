import { z } from 'zod'

const uuid = z.string().uuid()

export const Repo = z.object({
  id: uuid,
  projectId: uuid,
  gitlabProjectId: z.number().int(),
  pathWithNamespace: z.string(),
  webUrl: z.string().url(),
  defaultBranch: z.string(),
  createdAt: z.string(),
})
export type Repo = z.infer<typeof Repo>

/** Links a GitLab project to a portal project by its path, e.g. `group/sub/app`. */
export const RepoLink = z.object({ path: z.string().trim().min(1).max(300) })
export type RepoLink = z.infer<typeof RepoLink>

export const IssueSyncStatus = z.enum(['pending', 'synced', 'failed'])
export type IssueSyncStatus = z.infer<typeof IssueSyncStatus>

export const IssueSync = z.object({
  repoId: uuid,
  pathWithNamespace: z.string(),
  issueIid: z.number().int().nullable(),
  issueUrl: z.string().nullable(),
  status: IssueSyncStatus,
  lastSyncedAt: z.string().nullable(),
  error: z.string().nullable(),
})
export type IssueSync = z.infer<typeof IssueSync>

export const MergeRequestState = z.enum(['opened', 'merged', 'closed'])
export type MergeRequestState = z.infer<typeof MergeRequestState>
export const PipelineStatus = z.enum(['none', 'pending', 'running', 'success', 'failed', 'canceled'])
export type PipelineStatus = z.infer<typeof PipelineStatus>

export const MergeRequest = z.object({
  id: uuid,
  repoId: uuid,
  mrIid: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: MergeRequestState,
  sourceBranch: z.string(),
  pipeline: PipelineStatus.default('none'),
  updatedAt: z.string(),
})
export type MergeRequest = z.infer<typeof MergeRequest>

export const WorkItemCode = z.object({
  repos: z.array(Repo),
  issues: z.array(IssueSync),
  mergeRequests: z.array(MergeRequest),
  connected: z.boolean(),
})
export type WorkItemCode = z.infer<typeof WorkItemCode>

export const WorkItemReposPut = z.object({ repoIds: z.array(uuid).max(20) })
export type WorkItemReposPut = z.infer<typeof WorkItemReposPut>

export const GitLabStatus = z.object({
  configured: z.boolean(),
  reachable: z.boolean().nullable(),
  botUsername: z.string().nullable(),
  lastWebhookAt: z.string().nullable(),
})
export type GitLabStatus = z.infer<typeof GitLabStatus>

/** Creates a work item from an existing GitLab issue in one of the project's linked repos. */
export const IssueImport = z.object({
  repoId: uuid,
  issueIid: z.number().int().positive(),
  templateKey: z.string().min(1).optional(),
})
export type IssueImport = z.infer<typeof IssueImport>
