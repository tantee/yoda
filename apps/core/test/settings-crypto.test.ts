import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SecretDecryptError,
  checkCanary,
  decryptSecret,
  encodeMasterKey,
  encryptSecret,
  fingerprint,
  generateMasterKey,
  keyId,
  loadMasterKey,
  loadPreviousMasterKey,
  makeCanary,
  openBlob,
  rewrapBlob,
  rewrapEnvelope,
  sealBlob,
  takeMasterKey,
  masterKey,
} from '../src/settings/crypto.js'

// Obviously fake test keys: 32 repeated bytes.
const KEY_A = masterKey(Buffer.alloc(32, 0x11))
const KEY_B = masterKey(Buffer.alloc(32, 0x22))

describe('settings crypto', () => {
  it('round-trips a secret, with fresh nonces and data keys each time', () => {
    const a = encryptSecret(KEY_A, 'smtp.password', 'รหัสผ่าน-placeholder')
    const b = encryptSecret(KEY_A, 'smtp.password', 'รหัสผ่าน-placeholder')
    expect(decryptSecret(KEY_A, 'smtp.password', a)).toBe('รหัสผ่าน-placeholder')
    expect(a.nonce.length).toBe(12)
    expect(a.dekNonce.length).toBe(12)
    expect(a.wrappedDek.length).toBe(48)
    expect(a.nonce.equals(b.nonce)).toBe(false)
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.ciphertext.toString('utf8')).not.toContain('placeholder')
  })

  it('names the key id: the first 8 bytes of SHA-256("yoda-kid" || key), hex', () => {
    const raw = Buffer.alloc(32, 0x11)
    const expected = createHash('sha256').update('yoda-kid').update(raw).digest().subarray(0, 8).toString('hex')
    expect(keyId(raw)).toBe(expected)
    expect(KEY_A.id).toBe(expected)
    expect(KEY_A.id).not.toBe(KEY_B.id)
    expect(encryptSecret(KEY_A, 'gitlab.token', 'x').keyId).toBe(KEY_A.id)
  })

  it('detects tampering with the ciphertext, nonce or wrapped key', () => {
    const env = encryptSecret(KEY_A, 'gitlab.token', 'gitlab-token-placeholder')
    const flip = (b: Buffer, i = 0) => {
      const c = Buffer.from(b)
      c[i] = c[i]! ^ 1
      return c
    }
    expect(() => decryptSecret(KEY_A, 'gitlab.token', { ...env, ciphertext: flip(env.ciphertext) })).toThrow(SecretDecryptError)
    expect(() => decryptSecret(KEY_A, 'gitlab.token', { ...env, ciphertext: flip(env.ciphertext, env.ciphertext.length - 1) })).toThrow(SecretDecryptError)
    expect(() => decryptSecret(KEY_A, 'gitlab.token', { ...env, nonce: flip(env.nonce) })).toThrow(SecretDecryptError)
    expect(() => decryptSecret(KEY_A, 'gitlab.token', { ...env, wrappedDek: flip(env.wrappedDek) })).toThrow(SecretDecryptError)
    expect(() => decryptSecret(KEY_A, 'gitlab.token', { ...env, dekNonce: flip(env.dekNonce) })).toThrow(SecretDecryptError)
  })

  it('binds the ciphertext to its setting key (AAD)', () => {
    const env = encryptSecret(KEY_A, 'gitlab.token', 'gitlab-token-placeholder')
    expect(() => decryptSecret(KEY_A, 'smtp.password', env)).toThrow(SecretDecryptError)
  })

  it('refuses another master key, naming only the key id', () => {
    const env = encryptSecret(KEY_A, 'gitlab.token', 'gitlab-token-placeholder')
    let err: unknown
    try {
      decryptSecret(KEY_B, 'gitlab.token', env)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SecretDecryptError)
    expect(String((err as Error).message)).toContain(KEY_A.id)
    expect(String((err as Error).message)).not.toContain('placeholder')
    // Same id but a different key (a forged key_id) still fails on the GCM tag.
    expect(() => decryptSecret({ ...KEY_B, id: KEY_A.id }, 'gitlab.token', env)).toThrow(SecretDecryptError)
    // A keyring decrypts with whichever key the row names.
    expect(decryptSecret([KEY_B, KEY_A], 'gitlab.token', env)).toBe('gitlab-token-placeholder')
  })

  it('checks the key canary', () => {
    const canary = makeCanary(KEY_A)
    expect(canary.keyId).toBe(KEY_A.id)
    expect(checkCanary(KEY_A, canary.blob)).toBe(true)
    expect(checkCanary(KEY_B, canary.blob)).toBe(false)
    expect(checkCanary(KEY_A, Buffer.from('garbage'))).toBe(false)
    const tampered = Buffer.from(canary.blob)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
    expect(checkCanary(KEY_A, tampered)).toBe(false)
  })

  it('fingerprints values with a keyed hash, never the plain SHA-256', () => {
    const fp = fingerprint(KEY_A, 'smtp.password', 'hunter2-placeholder')
    expect(fp).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(fingerprint(KEY_A, 'smtp.password', 'hunter2-placeholder')).toBe(fp)
    expect(fingerprint(KEY_A, 'smtp.password', 'other')).not.toBe(fp)
    expect(fingerprint(KEY_B, 'smtp.password', 'hunter2-placeholder')).not.toBe(fp)
    expect(fingerprint(KEY_A, 'gitlab.token', 'hunter2-placeholder')).not.toBe(fp)
    const plain = createHash('sha256').update('hunter2-placeholder').digest('base64url')
    expect(plain.startsWith(fp)).toBe(false)
  })
})

describe('loadMasterKey', () => {
  const b64 = Buffer.alloc(32, 0x33).toString('base64')

  it('reads YODA_MASTER_KEY as base64 of 32 bytes', () => {
    const r = loadMasterKey({ YODA_MASTER_KEY: b64 })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.key.id).toBe(keyId(Buffer.alloc(32, 0x33)))
  })

  it('reads YODA_MASTER_KEY_FILE, trimming the trailing newline (R3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoda-mk-'))
    const file = join(dir, 'master-key')
    writeFileSync(file, `${b64}\n`)
    const r = loadMasterKey({ YODA_MASTER_KEY_FILE: file })
    expect(r.status).toBe('ok')
  })

  it('warns when the key file is readable by group or others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoda-mk-'))
    const file = join(dir, 'master-key')
    writeFileSync(file, `${b64}\n`, { mode: 0o644 })
    chmodSync(file, 0o644)
    const loose = loadMasterKey({ YODA_MASTER_KEY_FILE: file })
    expect(loose.status === 'ok' && loose.warning).toMatch(/readable by group or others/)
    chmodSync(file, 0o600)
    const tight = loadMasterKey({ YODA_MASTER_KEY_FILE: file })
    expect(tight.status === 'ok' && tight.warning).toBeUndefined()
  })

  it('takeMasterKey removes YODA_MASTER_KEY from the environment after loading it', () => {
    const env: NodeJS.ProcessEnv = { YODA_MASTER_KEY: b64, OTHER: 'x' }
    const r = takeMasterKey(env)
    expect(r.status).toBe('ok')
    expect(env).toEqual({ OTHER: 'x' })
  })

  it('prefers YODA_MASTER_KEY over the file', () => {
    const other = Buffer.alloc(32, 0x44).toString('base64')
    const r = loadMasterKey({ YODA_MASTER_KEY: other, YODA_MASTER_KEY_FILE: '/nonexistent/yoda-master-key' })
    expect(r.status === 'ok' && r.key.id).toBe(keyId(Buffer.alloc(32, 0x44)))
  })

  it('reports a missing or malformed key without echoing it', () => {
    expect(loadMasterKey({}).status).toBe('missing')
    expect(loadMasterKey({ YODA_MASTER_KEY: '' }).status).toBe('missing')
    expect(loadMasterKey({ YODA_MASTER_KEY_FILE: '/nonexistent/yoda-master-key' }).status).toBe('missing')
    const short = loadMasterKey({ YODA_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') })
    expect(short.status).toBe('malformed')
    const junk = loadMasterKey({ YODA_MASTER_KEY: 'zzz junk-key-value!' })
    expect(junk.status).toBe('malformed')
    expect(JSON.stringify(junk)).not.toContain('junk-key-value')
  })
})

describe('master key rotation primitives (§3.5)', () => {
  it('re-wraps only the data key: same ciphertext, new key id, opens with the new key and not the old', () => {
    const e = encryptSecret(KEY_A, 'smtp.password', 'placeholder-value')
    const r = rewrapEnvelope([KEY_A], KEY_B, 'smtp.password', e)
    expect(r.keyId).toBe(KEY_B.id)
    expect(r.ciphertext.equals(e.ciphertext)).toBe(true)
    expect(r.nonce.equals(e.nonce)).toBe(true)
    expect(r.wrappedDek.equals(e.wrappedDek)).toBe(false)
    expect(decryptSecret(KEY_B, 'smtp.password', r)).toBe('placeholder-value')
    expect(() => decryptSecret(KEY_A, 'smtp.password', r)).toThrow(SecretDecryptError)
    // The setting key still binds it.
    expect(() => decryptSecret(KEY_B, 'line.channelSecret', r)).toThrow(SecretDecryptError)
  })

  it('refuses to re-wrap an envelope no given key opens, or one moved onto another setting', () => {
    const e = encryptSecret(KEY_A, 'smtp.password', 'placeholder-value')
    expect(() => rewrapEnvelope([KEY_B], KEY_B, 'smtp.password', e)).toThrow(SecretDecryptError)
    expect(() => rewrapEnvelope([KEY_A], KEY_B, 'line.channelSecret', e)).toThrow(SecretDecryptError)
  })

  it('re-wraps a sealed blob (TOTP seed) for the new key', () => {
    const sealed = sealBlob(KEY_A, 'local_admin.totp:x', 'JBSWY3DPEHPK3PXP')
    const r = rewrapBlob([KEY_A], KEY_B, 'local_admin.totp:x', sealed.blob, sealed.keyId)
    expect(r.keyId).toBe(KEY_B.id)
    expect(openBlob(KEY_B, 'local_admin.totp:x', r.blob, r.keyId)).toBe('JBSWY3DPEHPK3PXP')
    expect(() => openBlob(KEY_A, 'local_admin.totp:x', r.blob, KEY_A.id)).toThrow(SecretDecryptError)
  })

  it('decrypts with a keyring by key id (the previous key during a rotation)', () => {
    const old = encryptSecret(KEY_A, 'smtp.password', 'old-placeholder')
    expect(decryptSecret([KEY_B, KEY_A], 'smtp.password', old)).toBe('old-placeholder')
  })

  it('generates a new random 32-byte key, as base64', () => {
    const a = generateMasterKey()
    const b = generateMasterKey()
    expect(a.key.length).toBe(32)
    expect(a.id).not.toBe(b.id)
    expect(encodeMasterKey(a)).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(loadMasterKey({ YODA_MASTER_KEY: encodeMasterKey(a) })).toMatchObject({ status: 'ok', key: { id: a.id } })
  })

  it('loads the previous key from `<file>.prev` when it is there and valid; otherwise none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yoda-mk-'))
    const file = join(dir, 'master-key')
    expect(loadPreviousMasterKey({ YODA_MASTER_KEY_FILE: file })).toBeNull()
    writeFileSync(`${file}.prev`, `${encodeMasterKey(KEY_A)}\n`, { mode: 0o600 })
    expect(loadPreviousMasterKey({ YODA_MASTER_KEY_FILE: file })?.id).toBe(KEY_A.id)
    writeFileSync(`${file}.prev`, 'not-a-key\n', { mode: 0o600 })
    expect(loadPreviousMasterKey({ YODA_MASTER_KEY_FILE: file })).toBeNull()
    expect(loadPreviousMasterKey({})).toBeNull()
  })
})
