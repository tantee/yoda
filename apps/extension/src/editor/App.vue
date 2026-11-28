<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getDraft, putDraft, type Draft } from '../drafts/db'

/**
 * The editor tab (editor.html?draft=<id>): restores the draft's annotation document and form, and saves both,
 * debounced, on every change, so closing the tab never loses a report.
 */
const { t } = useI18n()
const draft = ref<Draft | null>(null)
const missing = ref(false)
const imageUrl = ref('')
let saveTimer: ReturnType<typeof setTimeout> | null = null
const plain = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

async function load() {
  const id = new URLSearchParams(location.search).get('draft')
  const d = id ? await getDraft(id) : null
  if (!d) {
    missing.value = true
    return
  }
  draft.value = d
  const img = d.images[0]
  if (img) imageUrl.value = URL.createObjectURL(img.blob)
}

/** Saves the editor document and form after 400 ms of quiet. */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const d = draft.value
    if (!d) return
    // IndexedDB cannot clone Vue's proxies: the raw draft (its blobs as they are), with plain copies of the
    // editor document and the form.
    const raw = toRaw(d)
    void putDraft({ ...raw, editorDoc: plain(d.editorDoc), form: plain(d.form) as Draft['form'] })
  }, 400)
}

watch(() => [draft.value?.editorDoc, draft.value?.form], scheduleSave, { deep: true })
onMounted(load)
onBeforeUnmount(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})
</script>

<template>
  <v-app>
    <v-main>
      <div class="editor pa-4" data-testid="editor">
        <v-alert v-if="missing" type="warning" data-testid="draft-missing">{{ t('editor.draftMissing') }}</v-alert>
        <template v-else-if="draft">
          <img v-if="imageUrl" :src="imageUrl" alt="" class="editor__image" data-testid="editor-image" />
        </template>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.editor__image { max-width: 100%; display: block; }
</style>
