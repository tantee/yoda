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

  it('lists by prefix, sorted, with last-modified times', async () => {
    let now = new Date('2026-01-01T00:00:00Z')
    const s = createMemoryStorage(() => now)
    await s.put('projects/a/defects/1/x.png', Buffer.from('1'), 'image/png')
    now = new Date('2026-01-02T00:00:00Z')
    await s.put('projects/a/defects/0/y.png', Buffer.from('2'), 'image/png')
    await s.put('projects/b/doc.txt', Buffer.from('3'), 'text/plain')
    const out: { key: string; lastModified: Date }[] = []
    for await (const o of s.list('projects/a/')) out.push(o)
    expect(out.map((o) => [o.key, o.lastModified.toISOString()])).toEqual([
      ['projects/a/defects/0/y.png', '2026-01-02T00:00:00.000Z'],
      ['projects/a/defects/1/x.png', '2026-01-01T00:00:00.000Z'],
    ])
  })
})
