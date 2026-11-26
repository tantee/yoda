/**
 * Dialog rules (proposal §4.2, §6.6): one width per kind, full screen below 600 px, and Escape / backdrop close
 * only when nothing would be lost.
 */
export type DialogSize = 'confirm' | 'form' | 'editor'

export const DIALOG_WIDTHS: Record<DialogSize, number> = { confirm: 480, form: 560, editor: 800 }

export function dialogWidth(size: DialogSize = 'form'): number {
  return DIALOG_WIDTHS[size] ?? DIALOG_WIDTHS.form
}

/** Persistent (no Escape, no backdrop close) while saving, while something is typed, or when asked. */
export function dialogPersistent(o: { busy?: boolean; dirty?: boolean; persistent?: boolean }): boolean {
  return !!(o.busy || o.dirty || o.persistent)
}

/**
 * How a dialog sits on screen: centred from 600 px up; on phones a confirm is a bottom sheet (a short question
 * with its buttons under the thumb, not a blank full screen) and a form or editor takes the whole screen.
 */
export type DialogLayout = 'centered' | 'sheet' | 'fullscreen'

export function dialogLayout(size: DialogSize = 'form', phone: boolean): DialogLayout {
  if (!phone) return 'centered'
  return size === 'confirm' ? 'sheet' : 'fullscreen'
}
