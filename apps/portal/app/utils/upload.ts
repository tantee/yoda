import { MAX_UPLOAD_BYTES, UPLOAD_ALLOWED_TYPES } from '@yoda/shared'

/** Pre-send check using the same limits core enforces; returns an i18n key or null when acceptable. */
export function validateUpload(file: { size: number; type: string }): 'errors.tooLarge' | 'errors.unsupportedType' | null {
  const type = file.type.split(';')[0]!.trim().toLowerCase()
  if (!UPLOAD_ALLOWED_TYPES.includes(type)) return 'errors.unsupportedType'
  if (file.size > MAX_UPLOAD_BYTES) return 'errors.tooLarge'
  return null
}
