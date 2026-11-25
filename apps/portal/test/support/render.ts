import { renderToString } from '@vue/test-utils'
import type { Component } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'

/** Server-renders a component with Vuetify installed, for markup assertions without a DOM. */
export function render(component: Component, props: Record<string, unknown> = {}, slots: Record<string, string> = {}): Promise<string> {
  const vuetify = createVuetify({ components })
  return renderToString(component, { props, slots, global: { plugins: [vuetify] } })
}
