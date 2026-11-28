<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getDraft, putDraft, type Draft } from '../drafts/db'
import Canvas from './Canvas.vue'
import { apply, defaultBlock, initState, redo, undo, type EditorDoc, type Op, type State } from './doc'
import Toolbar, { type Tool } from './Toolbar.vue'
import ReportForm from './ReportForm.vue'
import { drawVector } from './draw'
import { flatten } from './flatten'

/**
 * The editor tab (editor.html?draft=<id>): annotate the screenshot (blur, mosaic and redact are burned into the
 * exported image; the original is never uploaded), then fill in the report. The document and the form are saved
 * to the draft, debounced, on every change.
 */
const { t } = useI18n()
const draft = ref<Draft | null>(null)
const missing = ref(false)
const base = shallowRef<ImageBitmap | null>(null)
const state = ref<State | null>(null)
const tool = ref<Tool>('arrow')
const colour = ref('#B3261E')
const block = ref(16)
const textAt = ref<{ x: number; y: number } | null>(null)
const textValue = ref('')
/** The clip, played in the editor (C2 adds mosaic regions on it). The object URL is revoked on unmount. */
const videoUrl = computed(() => (draft.value?.video ? URL.createObjectURL(draft.value.video) : null))
watch(videoUrl, (_n, old) => old && URL.revokeObjectURL(old))
let saveTimer: ReturnType<typeof setTimeout> | null = null
const plain = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

async function load() {
  const id = new URLSearchParams(location.search).get('draft')
  const d = id ? await getDraft(id) : null
  if (!d) {
    missing.value = true
    return
  }
  draft.value = d
  const img = d.images[0]
  if (img) {
    base.value = await createImageBitmap(img.blob)
    const saved = d.editorDoc as EditorDoc | undefined
    const doc = saved && saved.width === base.value.width ? saved : { width: base.value.width, height: base.value.height, ops: [] }
    state.value = initState(doc)
    block.value = defaultBlock(doc.width, doc.height)
  }
}

function add(op: Op) {
  if (state.value) state.value = apply(state.value, { add: op })
}

function addText() {
  const text = textValue.value.trim().slice(0, 500)
  if (text && textAt.value) add({ kind: 'text', at: textAt.value, text, colour: colour.value, size: 20 })
  textAt.value = null
  textValue.value = ''
}

const SHORTCUTS: Record<string, Tool> = { v: 'select', a: 'arrow', b: 'box', h: 'highlight', t: 'text', n: 'step', u: 'blur', m: 'mosaic', r: 'redact', c: 'crop' }
function onKey(ev: KeyboardEvent) {
  if (sent.value) return
  const target = ev.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  const k = ev.key.toLowerCase()
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') {
    ev.preventDefault()
    if (state.value) state.value = ev.shiftKey ? redo(state.value) : undo(state.value)
    return
  }
  if ((ev.ctrlKey || ev.metaKey) && k === 'y') {
    ev.preventDefault()
    if (state.value) state.value = redo(state.value)
    return
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return
  if (k === 'm' && ev.shiftKey) tool.value = tool.value === 'mosaic' ? 'mosaic-brush' : 'mosaic'
  else if (SHORTCUTS[k]) tool.value = SHORTCUTS[k]!
}

const doc = computed(() => state.value?.doc ?? null)

/** Set once the report is sent: the draft is deleted then, and nothing may write it back. */
const sent = ref(false)

function save() {
  saveTimer = null
  const d = draft.value
  if (!d || sent.value) return
  // IndexedDB cannot clone Vue's proxies: the raw draft (its blobs as they are) with plain copies of the rest.
  void putDraft({ ...toRaw(d), editorDoc: plain(doc.value), form: plain(d.form) })
}

function scheduleSave() {
  if (sent.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 400)
}

/** Closing the tab inside the debounce would lose the last edits: write them now. */
function flushSave() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  save()
}

function onSent() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  sent.value = true
}

watch(doc, scheduleSave, { deep: true })
watch(() => draft.value?.form, scheduleSave, { deep: true })
onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
  window.addEventListener('pagehide', flushSave)
})
onBeforeUnmount(() => {
  flushSave()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pagehide', flushSave)
  base.value?.close()
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
})
/** The image that is uploaded: blur, mosaic and redact burned in, annotations drawn, the crop applied. */
async function exportImage(): Promise<Blob | null> {
  if (!base.value || !doc.value) return null
  return flatten(base.value, doc.value, (ctx, ops) => drawVector(ctx, ops))
}

defineExpose({ doc, base, draft })
</script>

<template>
  <v-app>
    <v-main>
      <div class="editor" data-testid="editor">
        <v-alert v-if="missing" type="warning" class="ma-4" data-testid="draft-missing">{{ t('editor.draftMissing') }}</v-alert>
        <template v-else-if="draft">
          <section class="editor__stage" :class="{ 'editor__stage--sent': sent }" :inert="sent || undefined">
            <v-alert v-if="draft.notice === 'video_dropped'" type="warning" variant="tonal" density="compact" class="ma-2" data-testid="editor-video-dropped">{{ t('editor.videoDropped') }}</v-alert>
            <Toolbar
              v-model:tool="tool"
              v-model:colour="colour"
              v-model:block="block"
              :can-undo="!!state?.past.length"
              :can-redo="!!state?.future.length"
              @undo="state && (state = undo(state))"
              @redo="state && (state = redo(state))"
            />
            <div class="editor__hint text-caption text-medium-emphasis" data-testid="editor-hint">{{ t('editor.burnedIn') }}</div>
            <div class="editor__canvas">
              <Canvas v-if="base && doc" :base="base" :doc="doc" :tool="tool" :colour="colour" :block="block" @add="add" @text="(p) => (textAt = p)" />
              <video v-else-if="videoUrl" :src="videoUrl" controls class="editor__video" data-testid="editor-video" />
              <p v-else class="text-medium-emphasis pa-4" data-testid="editor-no-image">{{ t('editor.noImage') }}</p>
            </div>
          </section>
          <aside class="editor__side" data-testid="editor-side">
            <ReportForm :draft="draft" :flatten="exportImage" @sent="onSent" />
          </aside>
        </template>
      </div>
      <v-dialog :model-value="!!textAt" max-width="420" @update:model-value="(v: boolean) => !v && (textAt = null)">
        <v-card>
          <v-card-text>
            <v-text-field v-model="textValue" :label="t('editor.tool.text')" autofocus maxlength="500" data-testid="editor-text-input" @keyup.enter="addText" />
          </v-card-text>
          <v-card-actions class="justify-end">
            <v-btn variant="text" @click="textAt = null">{{ t('common.cancel') }}</v-btn>
            <v-btn color="primary" data-testid="editor-text-add" @click="addText">{{ t('common.save') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-main>
  </v-app>
</template>

<style scoped>
.editor { display: grid; grid-template-columns: minmax(0, 1fr) 400px; min-height: 100vh; }
.editor__stage { display: flex; flex-direction: column; min-width: 0; }
.editor__stage--sent { opacity: 0.6; }
.editor__hint { padding: 4px 12px; }
.editor__video { max-width: 100%; max-height: calc(100vh - 140px); display: block; background: #000; }
.editor__canvas { flex: 1; overflow: auto; padding: 12px; background: rgb(var(--v-theme-surface-light)); }
.editor__side { border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgb(var(--v-theme-surface)); overflow: auto; max-height: 100vh; }
@media (max-width: 960px) {
  .editor { grid-template-columns: 1fr; }
  .editor__side { border-left: 0; max-height: none; }
}
</style>
