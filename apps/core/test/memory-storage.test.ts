import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory.js'

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks)
}

describe('memory storage', () => {
  it('round-trips put/get/remove with a Thai key', async () => {
    const s = createMemoryStorage()
    const key = 'projects/1/รายงาน/ไฟล์.txt'
    await s.put(key, Buffer.from('สวัสดี'), 'text/plain')
    expect((await read(await s.get(key))).toString('utf8')).toBe('สวัสดี')
    await s.remove(key)
    await expect(s.get(key)).rejects.toMatchObject({ name: 'NoSuchKey' })
  })
})
