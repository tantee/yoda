import { isTooBroadPattern, normalizeMatchPattern, parseMatchPattern } from '@yoda/shared'

/** The application URL field's verdict: a Chrome match pattern, and never one that matches every site. */
export function validatePatternInput(s: string): 'ok' | 'invalid' | 'too_broad' {
  const p = normalizeMatchPattern(s)
  if (!p || !parseMatchPattern(p)) return 'invalid'
  return isTooBroadPattern(p) ? 'too_broad' : 'ok'
}
