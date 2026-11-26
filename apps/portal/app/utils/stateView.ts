/** How a failed load reads to the user: no response at all (network) is distinct from a 5xx. */
export function errorKind(e: unknown): { kind: 'network' | 'server' | 'other'; status: number | null } {
  const err = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? null
  if (typeof status === 'number' && status > 0) return { kind: status >= 500 ? 'server' : 'other', status }
  return { kind: 'network', status: null }
}
