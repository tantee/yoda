import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/knowledge/chunk.js'

/** Deterministic pseudo-random Thai text with no punctuation and no spaces. */
function thaiNoPunctuation(n: number): string {
  const letters = 'กขคงจฉชซญดตถทธนบปผพฟภมยรลวศษสหอฮะาิีึืุูเแโใไ่้๊๋็์'
  let seed = 42
  let out = ''
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    out += letters[seed % letters.length]
  }
  return out
}

/** Asserts chunks are in-order substrings of `text` that leave no gap and reach the end. */
function expectCovers(text: string, chunks: string[]): void {
  let reached = 0
  let from = 0
  for (const c of chunks) {
    const at = text.indexOf(c, from)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThanOrEqual(reached)
    reached = Math.max(reached, at + c.length)
    from = at + 1
  }
  expect(reached).toBe(text.length)
}

describe('chunkText', () => {
  it('splits 4000 chars of unpunctuated Thai into chunks of at most 1500 that cover the text', () => {
    const text = thaiNoPunctuation(4000)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500)
    expectCovers(text, chunks)
  })

  it('returns short text as one chunk and empty text as none', () => {
    expect(chunkText('ตารางผลแล็บ')).toEqual(['ตารางผลแล็บ'])
    expect(chunkText('   \n\n ')).toEqual([])
  })

  it('prefers paragraph breaks and overlaps consecutive chunks by at most `overlap` chars', () => {
    const para = (k: number) => `ย่อหน้า${k} ` + 'ข้อความ '.repeat(40).trim()
    const text = Array.from({ length: 12 }, (_, k) => para(k)).join('\n\n')
    const chunks = chunkText(text, 800, 100)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800)
    // Each chunk (after the overlap prefix) ends at a paragraph end.
    for (const c of chunks.slice(0, -1)) expect(c.endsWith('ข้อความ')).toBe(true)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!
      const cur = chunks[i]!
      const prevEnd = text.indexOf(prev) + prev.length
      const curStart = text.indexOf(cur, text.indexOf(prev) + 1)
      expect(prevEnd - curStart).toBeLessThanOrEqual(100)
    }
    expectCovers(text, chunks)
  })

  it('splits on sentence ends, newlines and spaces near the limit', () => {
    const sentences = Array.from({ length: 50 }, (_, k) => `This is sentence number ${k} of the report.`).join(' ')
    const chunks = chunkText(sentences, 300, 50)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300)
      expect(c.endsWith('.')).toBe(true)
    }
    expectCovers(sentences, chunks)

    const thaiLines = Array.from({ length: 60 }, (_, k) => `บรรทัดที่ ${k} ผลแล็บผู้ป่วยนอก`).join('\n')
    const lineChunks = chunkText(thaiLines, 400, 60)
    for (const c of lineChunks) expect(c.length).toBeLessThanOrEqual(400)
    expectCovers(thaiLines, lineChunks)
  })
})
