import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionLatest } from '@yoda/shared'

/** The release files core may serve: `yoda-reporter-<version>.zip` / `.crx`, nothing else (no paths). */
export const EXTENSION_FILE_RE = /^yoda-reporter-\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\.(zip|crx)$/

export const DEFAULT_EXTENSION_DIRS = ['/srv/yoda-extension', '/app/extension']

/** The first directory that holds `name` (a regular file), or null. `name` must match EXTENSION_FILE_RE. */
export async function findExtensionFile(dirs: readonly string[], name: string): Promise<{ path: string; size: number } | null> {
  if (!EXTENSION_FILE_RE.test(name)) return null
  for (const dir of dirs) {
    const path = join(dir, name)
    try {
      // A regular file only: a symlink (pointing anywhere) is never served.
      const s = await lstat(path)
      if (s.isFile()) return { path, size: s.size }
    } catch {
      // not in this directory
    }
  }
  return null
}

export const openExtensionFile = (path: string) => createReadStream(path)

/** The release built for this Yoda version, when core can serve its zip (and the signed CRX when present). */
export async function latestExtension(dirs: readonly string[], version: string, publicUrl: string): Promise<ExtensionLatest> {
  const base = `${publicUrl.replace(/\/+$/, '')}/api/extension/download`
  const zip = `yoda-reporter-${version}.zip`
  if (!(await findExtensionFile(dirs, zip))) return null
  const crx = `yoda-reporter-${version}.crx`
  return { version, zipUrl: `${base}/${zip}`, crxUrl: (await findExtensionFile(dirs, crx)) ? `${base}/${crx}` : null }
}
