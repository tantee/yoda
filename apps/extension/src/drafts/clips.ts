/**
 * Finished clips, handed from the offscreen document to the worker (a Blob cannot travel in a runtime message).
 * The worker takes a clip into a draft at once; anything left over (a crash in between) goes with the draft purge.
 */
export type Clip = { id: string; tabId: number; blob: Blob; durationMs: number; createdAt: number }

const DB = 'yoda-clips'
const STORE = 'clips'

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

export async function putClip(c: Clip): Promise<void> {
  await tx('readwrite', (s) => s.put(c))
}

/** Reads and deletes a clip. */
export async function takeClip(id: string): Promise<Clip | null> {
  const c = ((await tx<Clip>('readonly', (s) => s.get(id))) as Clip | undefined) ?? null
  if (c) await tx('readwrite', (s) => s.delete(id))
  return c
}

/** Clips older than `maxAgeMs` (never taken): removed. */
export async function purgeClips(now: number, maxAgeMs: number): Promise<number> {
  const all = ((await tx<Clip[]>('readonly', (s) => s.getAll())) as Clip[] | undefined) ?? []
  const old = all.filter((c) => now - c.createdAt > maxAgeMs)
  for (const c of old) await tx('readwrite', (s) => s.delete(c.id))
  return old.length
}
