import MarkdownIt from 'markdown-it'

// `html: false` escapes any raw HTML in the source, so the output is safe to bind with v-html.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

export function renderMarkdown(src: string): string {
  return md.render(src)
}
