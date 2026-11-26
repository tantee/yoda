import { describe, expect, it } from 'vitest'
import DialogCard from '../app/components/DialogCard.vue'
import { DIALOG_WIDTHS, dialogLayout, dialogPersistent, dialogWidth } from '../app/utils/dialogs'
import { render } from './support/render'

describe('dialogWidth', () => {
  it('uses the proposal widths: confirm 480, form 560, editor 800', () => {
    expect(DIALOG_WIDTHS).toEqual({ confirm: 480, form: 560, editor: 800 })
    expect(dialogWidth('confirm')).toBe(480)
    expect(dialogWidth('editor')).toBe(800)
  })
  it('defaults to the form width', () => {
    expect(dialogWidth()).toBe(560)
  })
})

describe('dialogPersistent', () => {
  it('closes on Escape and the backdrop only when nothing would be lost', () => {
    expect(dialogPersistent({})).toBe(false)
    expect(dialogPersistent({ busy: true })).toBe(true)
    expect(dialogPersistent({ dirty: true })).toBe(true)
    expect(dialogPersistent({ persistent: true })).toBe(true)
  })
})

describe('dialogLayout', () => {
  it('centres every dialog from 600 px up', () => {
    expect(dialogLayout('confirm', false)).toBe('centered')
    expect(dialogLayout('form', false)).toBe('centered')
    expect(dialogLayout('editor', false)).toBe('centered')
  })
  it('on phones, confirms sit at the bottom and forms and editors take the screen', () => {
    expect(dialogLayout('confirm', true)).toBe('sheet')
    expect(dialogLayout('form', true)).toBe('fullscreen')
    expect(dialogLayout('editor', true)).toBe('fullscreen')
    expect(dialogLayout(undefined, true)).toBe('fullscreen')
  })
})

describe('DialogCard', () => {
  it('labels the dialog with its title and puts the actions after a spacer', async () => {
    const html = await render(DialogCard, { title: 'ลบวาระ ประชุมประจำสัปดาห์?', titleId: 'd1' }, { default: '<p>body</p>', actions: '<button>ok</button>', start: '<button>extra</button>' })
    expect(html).toContain('<h2 id="d1"')
    expect(html).toContain('ลบวาระ ประชุมประจำสัปดาห์?')
    expect(html.indexOf('extra')).toBeLessThan(html.indexOf('v-spacer'))
    expect(html.indexOf('v-spacer')).toBeLessThan(html.indexOf('>ok<'))
    expect(html).not.toContain('dialog-close')
  })
  it('adds a labelled close button when full screen', async () => {
    const html = await render(DialogCard, { title: 'x', titleId: 'd2', closable: true })
    expect(html).toContain('data-testid="dialog-close"')
    expect(html).toContain('aria-label="common.close"')
    expect(html).not.toContain('v-card-actions')
  })
})
