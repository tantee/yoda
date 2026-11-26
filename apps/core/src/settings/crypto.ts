import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * Envelope encryption for secret settings (installer proposal §3.5). Each secret is AES-256-GCM encrypted under
 * its own random data key; the data key is wrapped with the master key (AES-256-GCM, its own nonce). The setting
 * key is the AAD of both, so a ciphertext copied onto another key does not decrypt. Errors name the key id only.
 *
 * The row version is deliberately not in the AAD: someone with write access to the database could put back an
 * older ciphertext of the same key (a rollback to a previous value) undetected. Database write access is trusted
 * here (it could equally rewrite non-secret settings); the AAD only stops moving a secret onto another key.
 */

export type MasterKey = { id: string; key: Buffer }

export type Envelope = {
  keyId: string
  wrappedDek: Buffer
  dekNonce: Buffer
  nonce: Buffer
  /** Ciphertext with the 16-byte GCM tag appended. */
  ciphertext: Buffer
}

/** A secret could not be decrypted: wrong or missing master key, or a tampered row. Carries no value. */
export class SecretDecryptError extends Error {
  constructor(readonly keyId: string | null) {
    super(keyId ? `secret not decryptable with master key ${keyId}` : 'secret not decryptable')
    this.name = 'SecretDecryptError'
  }
}

const ALG = 'aes-256-gcm'
const TAG = 16

/** The first 8 bytes of SHA-256("yoda-kid" || key), hex. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('yoda-kid').update(key).digest().subarray(0, 8).toString('hex')
}

export function masterKey(key: Buffer): MasterKey {
  if (key.length !== 32) throw new Error('master key must be 32 bytes')
  return { id: keyId(key), key }
}

function seal(key: Buffer, nonce: Buffer, plain: Buffer, aad: string): Buffer {
  const c = createCipheriv(ALG, key, nonce, { authTagLength: TAG })
  c.setAAD(Buffer.from(aad, 'utf8'))
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < TAG) throw new Error('short ciphertext')
  const d = createDecipheriv(ALG, key, nonce, { authTagLength: TAG })
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()])
}

export function encryptSecret(mk: MasterKey, settingKey: string, plaintext: string): Envelope {
  const dek = randomBytes(32)
  const dekNonce = randomBytes(12)
  const nonce = randomBytes(12)
  try {
    return {
      keyId: mk.id,
      wrappedDek: seal(mk.key, dekNonce, dek, `yoda-dek:${settingKey}`),
      dekNonce,
      nonce,
      ciphertext: seal(dek, nonce, Buffer.from(plaintext, 'utf8'), `yoda-setting:${settingKey}`),
    }
  } finally {
    dek.fill(0)
  }
}

/** Decrypts with the master key the envelope names (one key, or a keyring during rotation). */
export function decryptSecret(keys: MasterKey | MasterKey[], settingKey: string, env: Envelope): string {
  const mk = (Array.isArray(keys) ? keys : [keys]).find((k) => k.id === env.keyId)
  if (!mk) throw new SecretDecryptError(env.keyId)
  let dek: Buffer | undefined
  try {
    dek = open(mk.key, env.dekNonce, env.wrappedDek, `yoda-dek:${settingKey}`)
    return open(dek, env.nonce, env.ciphertext, `yoda-setting:${settingKey}`).toString('utf8')
  } catch {
    throw new SecretDecryptError(env.keyId)
  } finally {
    dek?.fill(0)
  }
}

const CANARY_KEY = '__key_canary__'
const CANARY_TEXT = 'yoda-key-canary-v1'
const CANARY_VERSION = 1

/** A known constant encrypted with the master key, packed into one blob (`setup_state.key_canary`). */
export function makeCanary(mk: MasterKey): { blob: Buffer; keyId: string } {
  const e = encryptSecret(mk, CANARY_KEY, CANARY_TEXT)
  return { blob: Buffer.concat([Buffer.from([CANARY_VERSION]), e.dekNonce, e.wrappedDek, e.nonce, e.ciphertext]), keyId: mk.id }
}

/** Whether `mk` decrypts the canary. A wrong key, a tampered or a malformed blob is false, never a throw. */
export function checkCanary(mk: MasterKey, blob: Buffer): boolean {
  if (blob.length < 1 + 12 + 48 + 12 + TAG || blob[0] !== CANARY_VERSION) return false
  const env: Envelope = {
    keyId: mk.id,
    dekNonce: blob.subarray(1, 13),
    wrappedDek: blob.subarray(13, 61),
    nonce: blob.subarray(61, 73),
    ciphertext: blob.subarray(73),
  }
  try {
    return decryptSecret(mk, CANARY_KEY, env) === CANARY_TEXT
  } catch {
    return false
  }
}

/**
 * The audit log's fingerprint of a secret (5.4): HMAC-SHA-256 under a key derived from the master key, first 16
 * bytes, base64url. It shows that a secret changed, and whether two changes set the same value, without being
 * brute-forceable from a database dump alone.
 */
export function fingerprint(mk: MasterKey, settingKey: string, value: string): string {
  const fpKey = Buffer.from(hkdfSync('sha256', mk.key, Buffer.alloc(0), 'yoda-audit-fingerprint', 32))
  return createHmac('sha256', fpKey).update(settingKey).update('\0').update(value, 'utf8').digest().subarray(0, 16).toString('base64url')
}

export type MasterKeyLoad =
  /** `warning`: the key file is readable by group or others (it should be 0600 or 0400). */
  | { status: 'ok'; key: MasterKey; warning?: string }
  | { status: 'missing' | 'malformed'; reason: string }

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9_-]+$/

/**
 * The master key from `YODA_MASTER_KEY` (base64 of 32 bytes) or the file `YODA_MASTER_KEY_FILE` names (the
 * bootstrap volume, R3); env wins. Never throws and never echoes the value.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): MasterKeyLoad {
  let raw = env.YODA_MASTER_KEY?.trim()
  let from = 'YODA_MASTER_KEY'
  let warning: string | undefined
  if (!raw && env.YODA_MASTER_KEY_FILE) {
    from = 'YODA_MASTER_KEY_FILE'
    try {
      raw = readFile(env.YODA_MASTER_KEY_FILE).trim()
      if ((statSync(env.YODA_MASTER_KEY_FILE).mode & 0o077) !== 0) {
        warning = 'YODA_MASTER_KEY_FILE is readable by group or others; make it 0600'
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'read_error'
      return { status: 'missing', reason: `${from}: ${code}` }
    }
  }
  if (!raw) return { status: 'missing', reason: 'not set' }
  if (!BASE64.test(raw)) return { status: 'malformed', reason: `${from}: not base64` }
  const bytes = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64')
  if (bytes.length !== 32) return { status: 'malformed', reason: `${from}: must decode to 32 bytes` }
  return { status: 'ok', key: masterKey(bytes), ...(warning ? { warning } : {}) }
}

/**
 * `loadMasterKey`, then removes YODA_MASTER_KEY from `env` (server.ts passes process.env), so the key does not
 * linger where child processes, crash reports or a later env dump could see it.
 */
export function takeMasterKey(env: NodeJS.ProcessEnv): MasterKeyLoad {
  const r = loadMasterKey(env)
  delete env.YODA_MASTER_KEY
  return r
}

const BLOB_VERSION = 1

/**
 * A value encrypted under the master key as one blob (version, data-key nonce, wrapped data key, nonce,
 * ciphertext + tag), for columns outside `settings` (the break-glass TOTP seed). `aad` binds it to its place.
 */
export function sealBlob(mk: MasterKey, aad: string, plaintext: string): { blob: Buffer; keyId: string } {
  const e = encryptSecret(mk, aad, plaintext)
  return { blob: Buffer.concat([Buffer.from([BLOB_VERSION]), e.dekNonce, e.wrappedDek, e.nonce, e.ciphertext]), keyId: mk.id }
}

/** Opens a `sealBlob`; throws `SecretDecryptError` for a wrong key, a tampered blob or another `aad`. */
export function openBlob(mk: MasterKey, aad: string, blob: Buffer, keyId: string): string {
  if (blob.length < 1 + 12 + 48 + 12 + TAG || blob[0] !== BLOB_VERSION) throw new SecretDecryptError(keyId)
  return decryptSecret(mk, aad, {
    keyId,
    dekNonce: blob.subarray(1, 13),
    wrappedDek: blob.subarray(13, 61),
    nonce: blob.subarray(61, 73),
    ciphertext: blob.subarray(73),
  })
}

/** A 32-byte key derived from the master key for one purpose (HKDF-SHA-256, `info` names the purpose). */
export function deriveKey(mk: MasterKey, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', mk.key, Buffer.alloc(0), info, 32))
}

/** A new random master key (rotation). */
export function generateMasterKey(): MasterKey {
  return masterKey(randomBytes(32))
}

/** The key as `YODA_MASTER_KEY` and the key file hold it: base64 of the 32 bytes. */
export function encodeMasterKey(mk: MasterKey): string {
  return mk.key.toString('base64')
}

/**
 * Rotation (§3.5): the data key is unwrapped with whichever of `from` the envelope names and wrapped again under
 * `to` (a new nonce). The ciphertext and its nonce stay as they are. Throws `SecretDecryptError` when no key in
 * `from` opens it, or when it does not belong to `settingKey`, so nothing unreadable is carried over silently.
 */
export function rewrapEnvelope(from: MasterKey[], to: MasterKey, settingKey: string, env: Envelope): Envelope {
  const mk = from.find((k) => k.id === env.keyId)
  if (!mk) throw new SecretDecryptError(env.keyId)
  let dek: Buffer | undefined
  try {
    dek = open(mk.key, env.dekNonce, env.wrappedDek, `yoda-dek:${settingKey}`)
    // The ciphertext must open too: a row whose data key unwraps but whose body was tampered with is not kept.
    open(dek, env.nonce, env.ciphertext, `yoda-setting:${settingKey}`).fill(0)
    const dekNonce = randomBytes(12)
    return { keyId: to.id, wrappedDek: seal(to.key, dekNonce, dek, `yoda-dek:${settingKey}`), dekNonce, nonce: env.nonce, ciphertext: env.ciphertext }
  } catch {
    throw new SecretDecryptError(env.keyId)
  } finally {
    dek?.fill(0)
  }
}

/** `rewrapEnvelope` for a `sealBlob` (the break-glass TOTP seed). */
export function rewrapBlob(from: MasterKey[], to: MasterKey, aad: string, blob: Buffer, keyId: string): { blob: Buffer; keyId: string } {
  if (blob.length < 1 + 12 + 48 + 12 + TAG || blob[0] !== BLOB_VERSION) throw new SecretDecryptError(keyId)
  const e = rewrapEnvelope(from, to, aad, {
    keyId,
    dekNonce: blob.subarray(1, 13),
    wrappedDek: blob.subarray(13, 61),
    nonce: blob.subarray(61, 73),
    ciphertext: blob.subarray(73),
  })
  return { blob: Buffer.concat([Buffer.from([BLOB_VERSION]), e.dekNonce, e.wrappedDek, e.nonce, e.ciphertext]), keyId: e.keyId }
}

/**
 * The key a rotation replaced, kept as `<YODA_MASTER_KEY_FILE>.prev` until `rotate-master-key --finish`: core
 * decrypts with it (never encrypts), so a value written by a core that still had the old key stays readable.
 * Null when there is no such file or it is not a valid key. Never throws.
 */
export function loadPreviousMasterKey(env: NodeJS.ProcessEnv, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): MasterKey | null {
  if (!env.YODA_MASTER_KEY_FILE) return null
  const r = loadMasterKey({ YODA_MASTER_KEY_FILE: `${env.YODA_MASTER_KEY_FILE}.prev` }, readFile)
  return r.status === 'ok' ? r.key : null
}

export type MasterKeySetup = {
  masterKey: MasterKeyLoad
  previousKey: MasterKey | null
  /** Re-reads the key file (a rotation while running); absent when the key came from YODA_MASTER_KEY. */
  keyLoader?: () => MasterKeyLoad
  /** Where the key came from: rotation writes the file, and cannot change an env value. */
  source: 'env' | 'file' | null
  file: string | null
}

/** Everything `SettingsStore.open` needs about the key, read once at boot; removes YODA_MASTER_KEY from `env`. */
export function takeMasterKeySetup(env: NodeJS.ProcessEnv): MasterKeySetup {
  const fromEnv = !!env.YODA_MASTER_KEY?.trim()
  const file = env.YODA_MASTER_KEY_FILE || null
  const masterKey = takeMasterKey(env)
  return {
    masterKey,
    previousKey: loadPreviousMasterKey(env),
    ...(!fromEnv && file ? { keyLoader: () => loadMasterKey({ YODA_MASTER_KEY_FILE: file }) } : {}),
    source: fromEnv ? 'env' : file ? 'file' : null,
    file,
  }
}
