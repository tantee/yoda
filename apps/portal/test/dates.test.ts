import { describe, expect, it } from 'vitest'
import { formatDate, formatDateShort, formatDateTime, formatRelative, formatTime } from '../app/utils/dates'

// 14:05 on 25 Nov 2026 in Asia/Bangkok (UTC+7).
const iso = '2026-11-25T07:05:30Z'

describe('formatDateTime', () => {
  it('shows Thai in the Buddhist era, 24 h, without seconds', () => {
    expect(formatDateTime(iso, 'th')).toBe('25 พ.ย. 2569 14:05')
  })
  it('shows English in the Gregorian calendar', () => {
    expect(formatDateTime(iso, 'en')).toBe('25 Nov 2026, 14:05')
  })
  it('uses Bangkok time whatever the machine zone', () => {
    expect(formatDateTime('2026-12-31T18:30:00Z', 'th')).toBe('1 ม.ค. 2570 01:30')
  })
  it('returns an empty string for missing or invalid input', () => {
    expect(formatDateTime(null, 'th')).toBe('')
    expect(formatDateTime('not a date', 'th')).toBe('')
  })
})

describe('formatDate', () => {
  it('formats a timestamp as a date only', () => {
    expect(formatDate(iso, 'th')).toBe('25 พ.ย. 2569')
    expect(formatDate(iso, 'en')).toBe('25 Nov 2026')
  })
  it('keeps a calendar date (YYYY-MM-DD) on its own day', () => {
    expect(formatDate('2026-11-25', 'th')).toBe('25 พ.ย. 2569')
    expect(formatDate('2026-01-01', 'en')).toBe('1 Jan 2026')
  })
})

describe('formatDateShort', () => {
  const now = new Date('2026-11-26T03:00:00Z')
  it('drops the year within the current year', () => {
    expect(formatDateShort('2026-11-23', 'th', now)).toBe('23 พ.ย.')
    expect(formatDateShort('2026-11-23', 'en', now)).toBe('23 Nov')
  })
  it('keeps the year for other years', () => {
    expect(formatDateShort('2025-11-23', 'th', now)).toBe('23 พ.ย. 2568')
  })
})

describe('formatTime', () => {
  it('shows HH:mm in Bangkok time', () => {
    expect(formatTime(iso, 'th')).toBe('14:05')
    expect(formatTime(iso, 'en')).toBe('14:05')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-11-25T10:05:00Z')
  it('says hours ago in short Thai', () => {
    expect(formatRelative('2026-11-25T07:05:00Z', 'th', now)).toBe('3 ชม. ที่แล้ว')
  })
  it('says minutes ago', () => {
    expect(formatRelative('2026-11-25T10:00:00Z', 'th', now)).toBe('5 นาทีที่แล้ว')
    expect(formatRelative('2026-11-25T10:00:00Z', 'en', now)).toBe('5 min. ago')
  })
  it('says now for under a minute and yesterday for a day', () => {
    expect(formatRelative('2026-11-25T10:04:40Z', 'th', now)).toBe('ขณะนี้')
    expect(formatRelative('2026-11-24T10:05:00Z', 'en', now)).toBe('yesterday')
  })
  it('falls back to the date after a week', () => {
    expect(formatRelative('2026-11-01T10:05:00Z', 'th', now)).toBe('1 พ.ย. 2569')
  })
})
