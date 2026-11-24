const MAX_CHARS = 500_000
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PLAIN = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])

/** Text of an uploaded file for search and AI context; null when none can be extracted. Never throws. */
export async function extractText(buf: Buffer, contentType: string, _fileName: string): Promise<string | null> {
  try {
    let text: string | null = null
    if (PLAIN.has(contentType)) {
      text = new TextDecoder('utf-8').decode(buf)
    } else if (contentType === 'application/pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      text = (await pdfText(pdf, { mergePages: true })).text
    } else if (contentType === DOCX) {
      const mammoth = await import('mammoth')
      text = (await mammoth.extractRawText({ buffer: buf })).value
    }
    if (text == null) return null
    const trimmed = text.replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim()
    return trimmed ? trimmed.slice(0, MAX_CHARS) : null
  } catch {
    return null
  }
}
