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
