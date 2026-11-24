/**
 * Break preferences inside a window, best first. Each regex's match end is where the chunk ends
 * (whitespace after the break is trimmed off the chunk). Thai has no sentence punctuation, so newlines
 * and spaces are the fallbacks before a hard cut.
 */
const BREAKS: RegExp[] = [
  /\n[ \t]*\n/g, // blank line (paragraph)
  /[.?!](?=\s)/g, // sentence end
  /\n/g, // line
  /\s/g, // space
]

/** A break is only taken if it keeps the chunk at least this fraction of `maxChars`, else try the next kind. */
const MIN_FILL = 0.5

function lastBreak(window: string, re: RegExp, min: number): number {
  let best = -1
  re.lastIndex = 0
  for (let m = re.exec(window); m; m = re.exec(window)) {
    // Paragraph/line/space breaks end before the whitespace; sentence ends keep the punctuation.
    const end = re.source.startsWith('[.?!]') ? m.index + m[0].length : m.index
    if (end >= min) best = end
  }
  return best
}

/**
 * Splits text into chunks of at most `maxChars`, preferring paragraph, sentence, line and space boundaries
 * (in that order); consecutive chunks overlap by up to `overlap` chars. Every chunk is a substring of `text`.
 */
export function chunkText(text: string, maxChars = 1500, overlap = 200): string[] {
  const ov = Math.max(0, Math.min(overlap, Math.floor(maxChars * MIN_FILL) - 1))
  const n = text.length
  const chunks: string[] = []
  let pos = 0
  while (pos < n) {
    // Skip leading whitespace so chunk boundaries are measured on content.
    while (pos < n && /\s/.test(text[pos]!)) pos++
    if (pos >= n) break
    let end: number
    if (n - pos <= maxChars) {
      end = n
    } else {
      const window = text.slice(pos, pos + maxChars)
      const min = Math.ceil(maxChars * MIN_FILL)
      let cut = -1
      for (const re of BREAKS) {
        cut = lastBreak(window, re, min)
        if (cut > 0) break
      }
      end = pos + (cut > 0 ? cut : maxChars)
    }
    const chunk = text.slice(pos, end).trimEnd()
    if (chunk) chunks.push(chunk)
    if (end >= n) break
    // Next chunk starts up to `ov` chars back, moved forward to a word start when one is in reach.
    let next = end - ov
    const ws = text.slice(next, end).search(/\s/)
    if (ws >= 0) next += ws + 1
    pos = Math.max(next, pos + 1)
  }
  return chunks
}
