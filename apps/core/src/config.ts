import { z } from 'zod'

export type Config = {
  port: number
  databaseUrl: string
  oidcIssuer: string
  oidcClientId: string
  staffGroup: string
  bootstrapAdmins: string[]
  anthropicApiKey?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  aiModelDraft: string
  aiModelFast: string
  aiEmbeddingModel?: string
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3AccessKey: string
  s3SecretKey: string
  aiWorkers: number
  /** Most automatic task assignments one person receives per Bangkok calendar day. */
  dailyTaskCap: number
  /** GitLab base URL (no trailing slash); unset = GitLab features off. */
  gitlabUrl?: string
  /** Bot token; only ever read from the environment. */
  gitlabToken?: string
  gitlabWebhookSecret?: string
  /** Base URL of the portal, used for links from GitLab issues back to it. */
  portalUrl: string
}

const modelId = z.string().regex(/^(anthropic|openai):.+$/, 'must be provider:model with provider anthropic or openai')
const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), s.optional())

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  STAFF_GROUP: z.string().min(1).default('/it-dev'),
  BOOTSTRAP_ADMINS: z.string().default(''),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
  OPENAI_BASE_URL: optional(z.string().url()),
  AI_MODEL_DRAFT: modelId.default('anthropic:claude-opus-5-5'),
  AI_MODEL_FAST: modelId.default('anthropic:claude-haiku-5-5'),
  AI_EMBEDDING_MODEL: optional(modelId),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('yoda'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  AI_WORKERS: z.coerce.number().int().min(1).max(32).default(2),
  DAILY_TASK_CAP: z.coerce.number().int().min(1).max(1000).default(8),
  GITLAB_URL: optional(z.string().url()),
  GITLAB_TOKEN: optional(z.string()),
  GITLAB_WEBHOOK_SECRET: optional(z.string().min(16)),
  PORTAL_URL: z.string().url().default('http://localhost:3000'),
})

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid environment: ${details}`)
  }
  const e = parsed.data
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    oidcIssuer: e.OIDC_ISSUER.replace(/\/+$/, ''),
    oidcClientId: e.OIDC_CLIENT_ID,
    staffGroup: e.STAFF_GROUP,
    bootstrapAdmins: e.BOOTSTRAP_ADMINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    openaiBaseUrl: e.OPENAI_BASE_URL,
    aiModelDraft: e.AI_MODEL_DRAFT,
    aiModelFast: e.AI_MODEL_FAST,
    aiEmbeddingModel: e.AI_EMBEDDING_MODEL,
    s3Endpoint: e.S3_ENDPOINT,
    s3Region: e.S3_REGION,
    s3Bucket: e.S3_BUCKET,
    s3AccessKey: e.S3_ACCESS_KEY,
    s3SecretKey: e.S3_SECRET_KEY,
    aiWorkers: e.AI_WORKERS,
    dailyTaskCap: e.DAILY_TASK_CAP,
    gitlabUrl: e.GITLAB_URL?.replace(/\/+$/, ''),
    gitlabToken: e.GITLAB_TOKEN,
    gitlabWebhookSecret: e.GITLAB_WEBHOOK_SECRET,
    portalUrl: e.PORTAL_URL.replace(/\/+$/, ''),
  }
}
