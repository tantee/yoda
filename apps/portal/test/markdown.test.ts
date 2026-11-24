import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../app/utils/markdown'

describe('renderMarkdown', () => {
  it('renders Markdown and never passes raw HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script>**ตัวหนา**')
    expect(html).toContain('<strong>ตัวหนา</strong>')
    expect(html).not.toContain('<script>')
  })
  it('opens links safely in a new tab', () => {
    const html = renderMarkdown('[x](https://a.b)')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
  })
  it('linkifies bare URLs with the same attributes and blocks javascript: links', () => {
    expect(renderMarkdown('see https://a.b/c')).toContain('rel="noopener noreferrer"')
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:')
  })
  it('never renders remote images', () => {
    const html = renderMarkdown('![a](https://evil.example/?q=1)')
    expect(html).not.toContain('<img')
  })
})
