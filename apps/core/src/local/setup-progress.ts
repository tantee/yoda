import { createHash } from 'node:crypto'
import { REQUIRED_FOR_COMPLETION, SETUP_STEPS, type OidcCurrent, type SetupStepId, type SetupStepState } from '@yoda/shared'
import { z } from 'zod'

/**
 * The setup wizard's progress (installer proposal §4.2: "progress is saved after each step"), kept in
 * `setup_state.setup_progress`. Most steps read the real state (the saved settings, the break-glass admin); this
 * record holds what the server cannot see otherwise: marks for the system check and the optional steps, when the
 * recovery kit was downloaded, the sign-in values the last passing OIDC test ran with, and the claim. Never a
 * secret: hashes of the sign-in values, a username and times.
 */

export const ProgressRecord = z.object({
  marks: z.record(z.string(), z.enum(['done', 'skipped'])).default({}),
  kitDownloadedAt: z.string().optional(),
  /** The setup session (hex of its id hash) that downloaded the kit: only it may have it issued again, briefly. */
  kitSession: z.string().optional(),
  /** The last passing connection test (discovery, JWKS, client) of the saved sign-in values. */
  oidcTested: z.object({ hash: z.string(), at: z.string() }).optional(),
  /**
   * The claim: who signed in through OIDC (and so became the first admin), with which sign-in values and staff
   * group (`claimHash`). `grantedAdmin`: the admin flag came from this claim (a later claim by someone else takes
   * it back).
   */
  claimed: z.object({ personId: z.string(), username: z.string(), hash: z.string(), at: z.string(), grantedAdmin: z.boolean().default(true) }).optional(),
})
export type ProgressRecord = z.infer<typeof ProgressRecord>

export function parseProgress(raw: unknown): ProgressRecord {
  const r = ProgressRecord.safeParse(raw ?? {})
  return r.success ? r.data : { marks: {} }
}

/** The sign-in values as one hash: a test or a claim counts only for the values it ran with. */
export function oidcHash(v: Pick<OidcCurrent, 'issuer' | 'clientId' | 'jwksUrl'>): string | null {
  if (!v.issuer) return null
  return createHash('sha256').update(JSON.stringify([v.issuer, v.clientId, v.jwksUrl ?? null])).digest('base64url')
}

/** The claim's hash: the sign-in values plus the staff group the claimer was checked against. */
export function claimHash(v: Pick<OidcCurrent, 'issuer' | 'clientId' | 'jwksUrl'>, staffGroup: string): string | null {
  const base = oidcHash(v)
  return base && createHash('sha256').update(JSON.stringify([base, staffGroup])).digest('base64url')
}

/** How long the session that downloaded the kit may have it issued again (a lost download, a reload). */
export const KIT_REISSUE_MS = 10 * 60_000

export type ProgressFacts = {
  /** This browser holds a setup session (the token step is behind it). */
  session: boolean
  /** The organisation name and the public URL are saved (in the database or env, not the default). */
  organisation: boolean
  /** The break-glass admin exists. */
  admin: boolean
  /** `oidcHash` of the sign-in values in effect (null: no issuer). */
  oidc: string | null
  /** `claimHash` of the sign-in values and staff group in effect. */
  claim: string | null
  /** The claimed person still exists and is a portal admin. */
  claimedIsAdmin: boolean
  record: ProgressRecord
}

/** Every step's state, in wizard order. */
export function stepStates(f: ProgressFacts): Record<SetupStepId, SetupStepState> {
  const mark = (s: SetupStepId): SetupStepState => f.record.marks[s] ?? 'todo'
  const claimed = !!f.record.claimed && f.claim !== null && f.record.claimed.hash === f.claim && f.claimedIsAdmin
  const tested = f.oidc !== null && (f.record.oidcTested?.hash === f.oidc || claimed)
  const out = {} as Record<SetupStepId, SetupStepState>
  for (const s of SETUP_STEPS) {
    out[s] =
      s === 'token' ? (f.session ? 'done' : 'todo')
      : s === 'organisation' ? (f.organisation ? 'done' : 'todo')
      : s === 'admin' ? (f.admin ? 'done' : 'todo')
      : s === 'signin' ? (tested ? 'done' : 'todo')
      : s === 'kit' ? (f.record.kitDownloadedAt ? 'done' : 'todo')
      : s === 'claim' ? (claimed ? 'done' : 'todo')
      : mark(s)
  }
  return out
}

/** The required steps (8.1) still open; empty means setup can be completed. */
export function missingSteps(states: Record<SetupStepId, SetupStepState>): SetupStepId[] {
  return REQUIRED_FOR_COMPLETION.filter((s) => states[s] !== 'done')
}

/** The bootstrap values a recovery kit carries besides the master key (from core's resolved env). */
export type KitBootstrap = { postgresUser: string | null; postgresPassword: string | null; s3AccessKey: string | null; s3SecretKey: string | null }

/**
 * The Postgres user and password (from DATABASE_URL, which init derives from the bootstrap volume or an external
 * database sets) and the storage keys, for the kit: with them a lost bootstrap volume next to a surviving database
 * volume is rebuilt (`.env` → init). A URL that does not parse gives nulls, never an error.
 */
export function kitBootstrapValues(c: { databaseUrl?: string; s3AccessKey?: string; s3SecretKey?: string }): KitBootstrap {
  let postgresUser: string | null = null
  let postgresPassword: string | null = null
  try {
    const u = new URL(c.databaseUrl ?? '')
    postgresUser = decodeURIComponent(u.username) || null
    postgresPassword = decodeURIComponent(u.password) || null
  } catch {
    // Not a URL: leave both out.
  }
  return { postgresUser, postgresPassword, s3AccessKey: c.s3AccessKey || null, s3SecretKey: c.s3SecretKey || null }
}

/**
 * The recovery kit (D7): one text file, the master key and the break-glass recovery codes, plus the bootstrap
 * values (the Postgres password and the storage keys), with what to do with them. Plain text so it prints and
 * opens anywhere; the portal offers it as a download and shows the codes.
 */
export function recoveryKitText(k: {
  installId: string
  publicUrl: string
  keyId: string
  masterKey: string
  username: string
  codes: string[]
  at: Date
  bootstrap?: KitBootstrap
}): string {
  const b = k.bootstrap
  const bootstrapLines = !b || (!b.postgresPassword && !b.s3AccessKey && !b.s3SecretKey)
    ? []
    : [
      '',
      '3. BOOTSTRAP VALUES (the bootstrap volume /var/lib/yoda) / ค่าในโวลุ่ม bootstrap',
      '--------------------------------------------------------------------',
      'As they were when this kit was made. Secret: anyone holding them and the',
      'database can sign in to it. If the bootstrap volume is lost but the',
      'database volume survives, put them in .env with the master key, then',
      'run dc up -d: init writes them back (docs/operations.md, section 4a).',
      'หากโวลุ่ม bootstrap หาย แต่ฐานข้อมูลยังอยู่ ให้ใส่ค่าเหล่านี้และกุญแจหลักใน .env แล้ว dc up -d',
      '',
      ...(b.postgresPassword ? [`POSTGRES_PASSWORD=${b.postgresPassword}`] : []),
      ...(b.postgresUser && b.postgresUser !== 'yoda' ? [`POSTGRES_USER=${b.postgresUser}`] : []),
      ...(b.s3AccessKey ? [`S3_ACCESS_KEY=${b.s3AccessKey}`] : []),
      ...(b.s3SecretKey ? [`S3_SECRET_KEY=${b.s3SecretKey}`] : []),
      `YODA_MASTER_KEY=${k.masterKey}`,
    ]
  const lines = [
    'YODA RECOVERY KIT / ชุดกู้คืนระบบ Yoda',
    '====================================================================',
    `Install ID:   ${k.installId}`,
    `Portal:       ${k.publicUrl}`,
    `Created:      ${k.at.toISOString()}`,
    '',
    'Keep this file offline, with your backups but not in the same place.',
    'Anyone holding it can read the stored secrets and sign in as the',
    'break-glass admin. It is shown once: Yoda never shows the master key again.',
    'เก็บไฟล์นี้แบบออฟไลน์ แยกจากที่เก็บไฟล์สำรองข้อมูล ผู้ที่มีไฟล์นี้อ่านความลับที่เก็บไว้',
    'และเข้าสู่ระบบด้วยบัญชีฉุกเฉินได้ ไฟล์นี้แสดงครั้งเดียว ระบบจะไม่แสดงกุญแจหลักอีก',
    '',
    '1. MASTER KEY (YODA_MASTER_KEY, base64) / กุญแจหลัก',
    '--------------------------------------------------------------------',
    `Key id: ${k.keyId}`,
    k.masterKey,
    '',
    'Restoring on a new host needs this key: put it in the bootstrap volume',
    '(/var/lib/yoda/core/master-key, mode 0600) or set YODA_MASTER_KEY.',
    'Without it, every stored secret has to be entered again.',
    'การกู้คืนบนเครื่องใหม่ต้องใช้กุญแจนี้ หากไม่มี ต้องใส่ความลับทุกค่าใหม่',
    '',
    `2. BREAK-GLASS ADMIN / บัญชีผู้ดูแลฉุกเฉิน: ${k.username}`,
    '--------------------------------------------------------------------',
    'Sign in at /recovery when Keycloak sign-in does not work. Each recovery',
    'code works once, in place of the authenticator code. Portal admins are',
    'told every time the account is used.',
    'ใช้ที่หน้า /recovery เมื่อเข้าสู่ระบบผ่าน Keycloak ไม่ได้ รหัสกู้คืนแต่ละรหัสใช้ได้ครั้งเดียว',
    '',
    ...k.codes.map((c, i) => `  ${String(i + 1).padStart(2, ' ')}. ${c}`),
    '',
    'Lost password: on the install host run',
    '  docker compose exec core yoda-admin reset-break-glass',
    ...bootstrapLines,
    '====================================================================',
  ]
  return `${lines.join('\n')}\n`
}

/** The kit's file name: the install id's first 8 characters keep two installs' kits apart. */
export function recoveryKitFilename(installId: string): string {
  return `yoda-recovery-kit-${installId.slice(0, 8)}.txt`
}
