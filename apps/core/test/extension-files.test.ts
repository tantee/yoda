import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findExtensionFile, latestExtension } from '../src/extension/files.js'
import { VERSION } from '../src/version.js'
import { resetDb, testDb } from './helpers.js'
import { makeApp } from './support.js'

let root: string
let signed: string
let built: string
let app: FastifyInstance

beforeEach(async () => {
  await resetDb(await testDb())
  root = mkdtempSync(join(tmpdir(), 'yoda-ext-'))
  signed = join(root, 'signed')
  built = join(root, 'built')
  mkdirSync(signed)
  mkdirSync(built)
  writeFileSync(join(root, 'secret.txt'), 'nope')
  app = await makeApp()
  app.deps.config.extensionDirs = [signed, built]
})
afterEach(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('extension files', () => {
  it('download refuses ../, other names and unknown files with 404', async () => {
    writeFileSync(join(built, `yoda-reporter-${VERSION}.zip`), 'zip')
    for (const f of ['..%2Fsecret.txt', 'secret.txt', 'yoda-reporter-9.9.9.zip', 'yoda-reporter-1.2.0.exe', `..%2F..%2Fbuilt%2Fyoda-reporter-${VERSION}.zip`]) {
      const res = await app.inject({ url: `/extension/download/${f}` })
      expect(res.statusCode, f).toBe(404)
    }
    expect(await findExtensionFile([built], '../secret.txt')).toBeNull()
  })

  it('serves the zip and the crx with their types; the first directory holding a file wins', async () => {
    writeFileSync(join(built, `yoda-reporter-${VERSION}.zip`), 'built-zip')
    writeFileSync(join(signed, `yoda-reporter-${VERSION}.zip`), 'signed-zip')
    writeFileSync(join(signed, `yoda-reporter-${VERSION}.crx`), 'crx')
    const zip = await app.inject({ url: `/extension/download/yoda-reporter-${VERSION}.zip` })
    expect(zip.statusCode).toBe(200)
    expect(zip.body).toBe('signed-zip')
    expect(zip.headers['content-type']).toBe('application/zip')
    expect(zip.headers['x-content-type-options']).toBe('nosniff')
    const crx = await app.inject({ url: `/extension/download/yoda-reporter-${VERSION}.crx` })
    expect(crx.headers['content-type']).toBe('application/x-chrome-extension')
  })

  it('latest finds the zip for VERSION', async () => {
    writeFileSync(join(built, `yoda-reporter-${VERSION}.zip`), 'zip')
    const res = await app.inject({ url: '/extension/latest' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: VERSION, zipUrl: `http://localhost:3000/api/extension/download/yoda-reporter-${VERSION}.zip`, crxUrl: null })
    writeFileSync(join(signed, `yoda-reporter-${VERSION}.crx`), 'crx')
    expect((await latestExtension([signed, built], VERSION, 'https://yoda.example.org/'))?.crxUrl).toBe(`https://yoda.example.org/api/extension/download/yoda-reporter-${VERSION}.crx`)
  })

  it('latest is null when there is none', async () => {
    writeFileSync(join(built, 'yoda-reporter-0.0.1.zip'), 'old')
    const res = await app.inject({ url: '/extension/latest' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })
})
