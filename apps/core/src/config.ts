import { z } from 'zod'

export type Config = {
  port: number
  databaseUrl: string
  oidcIssuer: string
  oidcClientId: string
  staffGroup: string
  bootstrapAdmins: string[]
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  STAFF_GROUP: z.string().min(1).default('/it-dev'),
  BOOTSTRAP_ADMINS: z.string().default(''),
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
  }
}
