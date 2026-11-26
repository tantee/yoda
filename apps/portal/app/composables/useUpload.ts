import type { Attachment } from '@yoda/shared'
import { loginLocale } from '~/utils/loginLocale'
import { sessionEnded } from '~/utils/session'
import { validateUpload } from '~/utils/upload'

export class UploadError extends Error {
  constructor(public key: string) {
    super(key)
  }
}

export function useUpload() {
  const { $keycloak } = useNuxtApp()

  async function authHeaders(): Promise<Headers> {
    try {
      await $keycloak.updateToken(30)
    } catch {
      // Sign in again only when the session really ended; a refresh that failed while offline (or with Keycloak
      // briefly down) fails just this request, and the page offers a retry.
      if (sessionEnded($keycloak)) {
        await $keycloak.login({ locale: loginLocale(document.cookie) })
        throw new Error('session_expired')
      }
      throw new Error('token_refresh_failed')
    }
    return new Headers({ Authorization: `Bearer ${$keycloak.token}` })
  }

  async function send(url: string, file: File, fields: Record<string, string>): Promise<Attachment> {
    const bad = validateUpload(file)
    if (bad) throw new UploadError(bad)
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append('file', file, file.name) // file last so fields are parsed first
    const res = await fetch(url, { method: 'POST', headers: await authHeaders(), body: form })
    if (res.status === 413) throw new UploadError('errors.tooLarge')
    if (res.status === 415) throw new UploadError('errors.unsupportedType')
    if (res.status === 403) throw new UploadError('errors.forbidden')
    if (res.status === 404) throw new UploadError('errors.notFound')
    if (!res.ok) throw new UploadError('errors.generic')
    return (await res.json()) as Attachment
  }

  async function upload(
    projectId: string,
    file: File,
    opts: { workItemId?: string; taskId?: string; noAi?: boolean } = {},
  ): Promise<Attachment> {
    const fields: Record<string, string> = { noAi: opts.noAi ? 'true' : 'false' }
    if (opts.workItemId) fields.workItemId = opts.workItemId
    if (opts.taskId) fields.taskId = opts.taskId
    return send(`/api/projects/${projectId}/attachments`, file, fields)
  }

  /** Chat upload: the file is attached to the conversation, then referenced by the next message. */
  function uploadToConversation(conversationId: string, file: File, opts: { noAi?: boolean } = {}): Promise<Attachment> {
    return send(`/api/conversations/${conversationId}/attachments`, file, { noAi: opts.noAi ? 'true' : 'false' })
  }

  /** Fetches with the bearer token and saves through an object URL (never a token in a URL). */
  async function download(attachmentId: string, fileName: string, conversationId?: string): Promise<void> {
    const path = conversationId
      ? `/api/conversations/${conversationId}/attachments/${attachmentId}/download`
      : `/api/attachments/${attachmentId}/download`
    const res = await fetch(path, { headers: await authHeaders() })
    if (!res.ok) throw new UploadError(res.status === 404 ? 'errors.notFound' : 'errors.generic')
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  return { upload, uploadToConversation, download }
}
