export function errorKey(e: unknown): string {
  const err = e as { statusCode?: number; status?: number; response?: { status?: number } }
  const status = err?.statusCode ?? err?.status ?? err?.response?.status
  if (status === 403) return 'errors.forbidden'
  if (status === 404) return 'errors.notFound'
  return 'errors.generic'
}
