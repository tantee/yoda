import type { ConsoleEntry, DefectBuild, NetworkEntry } from '@yoda/shared'
import type { PageMetadata } from '../capture/metadata'

/**
 * Drafts live in the extension's IndexedDB (`yoda-drafts`) until sent, discarded, or 24 hours old: a closed
 * editor or a reconnect never loses a report, and a resend reuses its Idempotency-Key.
 */
export type DraftImage = { role: 'screenshot' | 'screenshot_full'; blob: Blob }
export type Draft = {
  id: string
  createdAt: number
  profileId: string
  tabId: number
  tabUrl: string
  metadata?: PageMetadata
  build?: DefectBuild | null
  console: ConsoleEntry[]
  network: NetworkEntry[]
  images: DraftImage[]
  video?: Blob
  buffer?: Blob[]
  /** The annotation document (B9). */
  editorDoc?: unknown
  /** The report form as typed (B10). */
  form?: Record<string, unknown>
  /** Fixed at creation: every send of this draft uses it, so a retry never files twice. */
  idempotencyKey: string
}

const DB = 'yoda-drafts'
const STORE = 'drafts'
export const DRAFT_TTL_MS = 24 * 3600_000

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const r = fn(t.objectStore(STORE))
      t.oncomplete = () => resolve(r ? r.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}

export function newDraft(o: { profileId: string; tabId: number; tabUrl: string }): Draft {
  return { id: crypto.randomUUID(), createdAt: Date.now(), ...o, console: [], network: [], images: [], idempotencyKey: crypto.randomUUID() }
}

export async function putDraft(d: Draft): Promise<void> {
  await tx('readwrite', (s) => s.put(d))
}

export async function getDraft(id: string): Promise<Draft | null> {
  return ((await tx<Draft>('readonly', (s) => s.get(id))) as Draft | undefined) ?? null
}

export async function listDrafts(): Promise<Draft[]> {
  return ((await tx<Draft[]>('readonly', (s) => s.getAll())) as Draft[] | undefined) ?? []
}

export async function deleteDraft(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}

/** Removes every draft of a profile (when the profile is removed). */
export async function deleteDraftsOf(profileId: string): Promise<number> {
  const mine = (await listDrafts()).filter((d) => d.profileId === profileId)
  for (const d of mine) await deleteDraft(d.id)
  return mine.length
}

/** Removes drafts older than 24 hours (called when the worker starts and whenever it opens the editor). */
export async function purgeOldDrafts(now: number): Promise<number> {
  const old = (await listDrafts()).filter((d) => now - d.createdAt > DRAFT_TTL_MS)
  for (const d of old) await deleteDraft(d.id)
  return old.length
}
