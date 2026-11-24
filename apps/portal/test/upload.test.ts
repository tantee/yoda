import { describe, expect, it } from 'vitest'
import { validateUpload } from '../app/utils/upload'

describe('validateUpload', () => {
  it('rejects files over 25 MB', () => {
    expect(validateUpload({ size: 26 * 1024 * 1024, type: 'text/plain' })).toBe('errors.tooLarge')
  })
  it('rejects unsupported types', () => {
    expect(validateUpload({ size: 10, type: 'application/x-msdownload' })).toBe('errors.unsupportedType')
    expect(validateUpload({ size: 10, type: '' })).toBe('errors.unsupportedType')
  })
  it('accepts allowed files, including charset-suffixed types', () => {
    expect(validateUpload({ size: 10, type: 'application/pdf' })).toBeNull()
    expect(validateUpload({ size: 25 * 1024 * 1024, type: 'text/plain;charset=utf-8' })).toBeNull()
  })
})
