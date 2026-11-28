import { Readable } from 'node:stream'
import type { Storage } from './s3.js'

/**
 * In-memory Storage for tests. Missing keys throw an error shaped like the S3 SDK's NoSuchKey. `now` stamps each
 * put's last-modified time (tests move it to age objects).
 */
export function createMemoryStorage(now: () => Date = () => new Date()): Storage {
  const objects = new Map<string, { buf: Buffer; at: Date }>()
  return {
    async put(key, body) {
      objects.set(key, { buf: Buffer.from(body), at: now() })
    },
    async get(key) {
      const buf = objects.get(key)?.buf
      if (!buf) {
        throw Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        })
      }
      return Readable.from([buf])
    },
    async remove(key) {
      objects.delete(key)
    },
    async *list(prefix) {
      for (const [key, o] of [...objects].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) if (key.startsWith(prefix)) yield { key, lastModified: o.at }
    },
    async ping() {},
  }
}
