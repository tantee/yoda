import { normaliseYodaUrl } from '../connect/connect'
import { getRefresh, setRefresh } from './secrets'
import { profiles, saveProfile, updateProfile, type Profile } from './store'
import { z } from 'zod'
import { parseMatchPattern } from '@yoda/shared'

/**
 * Managed configuration (decision 3, phase 3): IT sets it through Chrome or Edge policy (storage.managed, schema in
 * public/managed-schema.json; docs/guides/extension-admin.md). Policy never carries a token: its Yodas are
 * pre-seeded, locked profiles that the tester still approves once.
 */
export const Policy = z
  .object({
    instances: z
      .array(z.object({ name: z.string().min(1).max(120), url: z.string().max(500), default: z.boolean().optional() }))
      .max(20)
      .default([]),
    rules: z
      .array(
        z.object({
          pattern: z.string().max(500).refine((p) => parseMatchPattern(p) !== null, 'not a match pattern'),
          instance: z.string().min(1).max(500),
          projectId: z.string().uuid().optional(),
          environment: z.string().max(100).optional(),
          production: z.boolean().default(false),
        }),
      )
      .max(500)
      .default([]),
    allowVideo: z.boolean().default(true),
    allowBuffer: z.boolean().default(true),
    sessionOnly: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    for (const [i, inst] of p.instances.entries()) if (!normaliseYodaUrl(inst.url).ok) ctx.addIssue({ code: 'custom', path: ['instances', i, 'url'], message: 'not an https Yoda address' })
  })
export type Policy = z.infer<typeof Policy>

const DEFAULTS: Policy = { instances: [], rules: [], allowVideo: true, allowBuffer: true, sessionOnly: false }

/** The policy as set, or the defaults with a notice when it does not validate (a broken policy never locks anyone out). */
export async function readPolicy(): Promise<{ policy: Policy; notice: 'invalid_policy' | null }> {
  let raw: Record<string, unknown> = {}
  try {
    raw = ((await chrome.storage.managed.get(null)) as Record<string, unknown> | undefined) ?? {}
  } catch {
    return { policy: DEFAULTS, notice: null }
  }
  const parsed = Policy.safeParse(raw)
  if (parsed.success) return { policy: parsed.data, notice: null }
  console.warn('Yoda Reporter: the managed policy is invalid and was ignored', parsed.error.issues)
  return { policy: DEFAULTS, notice: 'invalid_policy' }
}

const originOf = (url: string) => {
  const n = normaliseYodaUrl(url)
  return n.ok ? n.origin : null
}

/** The profile a policy rule's `instance` names: by name, or by its Yoda address. */
export function instanceProfile(instance: string, list: Profile[]): Profile | null {
  const origin = originOf(instance)
  return list.find((p) => p.name === instance || (origin !== null && p.url === origin)) ?? null
}

/**
 * Applies the policy to the stored profiles: policy Yodas are added (or an existing one taken over) as managed,
 * locked profiles; one dropped from policy is unlocked; `sessionOnly` moves every refresh token to storage.session.
 */
export async function applyPolicy(policy: Policy): Promise<void> {
  const wanted = new Map<string, Policy['instances'][number]>()
  for (const i of policy.instances) {
    const o = originOf(i.url)
    if (o) wanted.set(o, i)
  }
  const list = await profiles()
  for (const [origin, inst] of wanted) {
    const existing = list.find((p) => p.url === origin)
    if (existing) {
      await updateProfile(existing.id, { managed: true, ...(inst.default ? { isDefault: true } : {}) })
    } else {
      await saveProfile({
        id: crypto.randomUUID(),
        name: inst.name,
        colour: '#1f5fbf',
        url: origin,
        isDefault: inst.default === true || list.length === 0,
        managed: true,
        sessionOnly: policy.sessionOnly,
        grantId: null,
        person: null,
        // No token comes from policy: the tester approves once in Yoda.
        needsReconnect: true,
      })
    }
  }
  for (const p of list) if (p.managed && !wanted.has(p.url)) await updateProfile(p.id, { managed: false })
  if (policy.sessionOnly) {
    for (const p of await profiles()) {
      if (p.sessionOnly) continue
      const token = await getRefresh(p)
      const next = await updateProfile(p.id, { sessionOnly: true })
      if (next) await setRefresh(next, token)
    }
  }
}
