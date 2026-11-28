import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import type { Config } from '../config.js'

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<NodeJS.ReadableStream>
  remove(key: string): Promise<void>
  /** Every object whose key starts with `prefix`, with its last-modified time (the defect orphan sweep). */
  list(prefix: string): AsyncIterable<{ key: string; lastModified: Date }>
  /** Throws when the bucket cannot be reached (readiness). */
  ping(): Promise<void>
}

/** S3-compatible storage (RustFS in dev). Creates the bucket when missing. `prefix` namespaces every key (tests). */
export async function createS3Storage(
  config: Pick<Config, 's3Endpoint' | 's3Region' | 's3Bucket' | 's3AccessKey' | 's3SecretKey'>,
  opts: { prefix?: string } = {},
): Promise<Storage> {
  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  })
  const Bucket = config.s3Bucket
  try {
    await client.send(new HeadBucketCommand({ Bucket }))
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket }))
    } catch (err) {
      // Another process may have created it in between.
      const name = (err as { name?: string }).name
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
    }
  }
  const k = (key: string) => (opts.prefix ?? '') + key
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: k(key), Body: body, ContentType: contentType }))
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: k(key) }))
      return res.Body as Readable
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: k(key) }))
    },
    async *list(prefix) {
      let ContinuationToken: string | undefined
      const base = opts.prefix ?? ''
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix: k(prefix), ContinuationToken }))
        for (const o of res.Contents ?? []) {
          // An object without a time is never old enough to sweep.
          if (o.Key && o.LastModified && o.Key.startsWith(base)) yield { key: o.Key.slice(base.length), lastModified: o.LastModified }
        }
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (ContinuationToken)
    },
    async ping() {
      await client.send(new HeadBucketCommand({ Bucket }))
    },
  }
}
