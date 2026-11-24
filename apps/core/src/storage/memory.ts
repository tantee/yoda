import { Readable } from 'node:stream'
import type { Storage } from './s3.js'

/** In-memory Storage for tests. Missing keys throw an error shaped like the S3 SDK's NoSuchKey. */
export function createMemoryStorage(): Storage {
  const objects = new Map<string, Buffer>()
  return {
    async put(key, body) {
      objects.set(key, Buffer.from(body))
    },
    async get(key) {
      const buf = objects.get(key)
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
  }
}
