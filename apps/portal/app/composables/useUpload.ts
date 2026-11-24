import type { Attachment } from '@yoda/shared'
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
      await $keycloak.login()
      throw new Error('session_expired')
    }
    return new Headers({ Authorization: `Bearer ${$keycloak.token}` })
  }

  async function upload(
    projectId: string,
    file: File,
    opts: { workItemId?: string; taskId?: string; noAi?: boolean } = {},
  ): Promise<Attachment> {
    const bad = validateUpload(file)
    if (bad) throw new UploadError(bad)
    const form = new FormData()
    if (opts.workItemId) form.append('workItemId', opts.workItemId)
    if (opts.taskId) form.append('taskId', opts.taskId)
    form.append('noAi', opts.noAi ? 'true' : 'false')
    form.append('file', file, file.name) // file last so fields are parsed first
    const res = await fetch(`/api/projects/${projectId}/attachments`, {
      method: 'POST',
      headers: await authHeaders(),
      body: form,
    })
    if (res.status === 413) throw new UploadError('errors.tooLarge')
    if (res.status === 415) throw new UploadError('errors.unsupportedType')
    if (res.status === 403) throw new UploadError('errors.forbidden')
    if (res.status === 404) throw new UploadError('errors.notFound')
    if (!res.ok) throw new UploadError('errors.generic')
    return (await res.json()) as Attachment
  }

  /** Fetches with the bearer token and saves through an object URL (never a token in a URL). */
  async function download(attachmentId: string, fileName: string): Promise<void> {
    const res = await fetch(`/api/attachments/${attachmentId}/download`, { headers: await authHeaders() })
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

  return { upload, download }
}
