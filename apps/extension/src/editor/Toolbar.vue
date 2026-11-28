<script setup lang="ts">
import { useI18n } from 'vue-i18n'

export type Tool = 'select' | 'arrow' | 'box' | 'highlight' | 'text' | 'step' | 'blur' | 'mosaic' | 'mosaic-brush' | 'redact' | 'crop'

/** The editor's tools, in the mockup's order: draw | hide (blur, mosaic, redact) and crop | undo, redo | colours. */
defineProps<{ tool: Tool; colour: string; block: number; canUndo: boolean; canRedo: boolean }>()
const emit = defineEmits<{ 'update:tool': [Tool]; 'update:colour': [string]; 'update:block': [number]; undo: []; redo: [] }>()
const { t } = useI18n()

const draw: { tool: Tool; icon: string; key: string }[] = [
  { tool: 'select', icon: 'mdi-cursor-default-outline', key: 'V' },
  { tool: 'arrow', icon: 'mdi-arrow-top-right', key: 'A' },
  { tool: 'box', icon: 'mdi-square-outline', key: 'B' },
  { tool: 'highlight', icon: 'mdi-marker', key: 'H' },
  { tool: 'text', icon: 'mdi-format-text', key: 'T' },
  { tool: 'step', icon: 'mdi-numeric-1-circle-outline', key: 'N' },
]
const hide: { tool: Tool; icon: string; key: string }[] = [
  { tool: 'blur', icon: 'mdi-blur', key: 'U' },
  { tool: 'mosaic', icon: 'mdi-checkerboard', key: 'M' },
  { tool: 'mosaic-brush', icon: 'mdi-brush', key: '⇧M' },
  { tool: 'redact', icon: 'mdi-rectangle', key: 'R' },
  { tool: 'crop', icon: 'mdi-crop', key: 'C' },
]
const colours = ['#B3261E', '#1F5FBF', '#7A4F00', '#1D6B3A', '#1A2433']
</script>

<template>
  <div class="toolbar" role="toolbar" :aria-label="t('editor.tools')" data-testid="editor-toolbar">
    <v-btn
      v-for="b in draw"
      :key="b.tool"
      :icon="b.icon"
      size="small"
      :variant="tool === b.tool ? 'tonal' : 'text'"
      :color="tool === b.tool ? 'primary' : undefined"
      :title="`${t(`editor.tool.${b.tool}`)} (${b.key})`"
      :aria-pressed="tool === b.tool"
      :data-testid="`tool-${b.tool}`"
      @click="emit('update:tool', b.tool)"
    />
    <v-divider vertical class="mx-1" />
    <v-btn
      v-for="b in hide"
      :key="b.tool"
      :icon="b.icon"
      size="small"
      :variant="tool === b.tool ? 'tonal' : 'text'"
      :color="tool === b.tool ? 'primary' : undefined"
      :title="`${t(`editor.tool.${b.tool}`)} (${b.key})`"
      :aria-pressed="tool === b.tool"
      :data-testid="`tool-${b.tool}`"
      @click="emit('update:tool', b.tool)"
    />
    <v-divider vertical class="mx-1" />
    <v-btn icon="mdi-undo" size="small" variant="text" :disabled="!canUndo" :title="`${t('editor.undo')} (Ctrl+Z)`" data-testid="tool-undo" @click="emit('undo')" />
    <v-btn icon="mdi-redo" size="small" variant="text" :disabled="!canRedo" :title="`${t('editor.redo')} (Ctrl+Shift+Z)`" data-testid="tool-redo" @click="emit('redo')" />
    <v-divider vertical class="mx-1" />
    <button
      v-for="c in colours"
      :key="c"
      type="button"
      class="swatch"
      :class="{ 'swatch--on': c === colour }"
      :style="{ background: c }"
      :aria-label="c"
      :data-testid="`colour-${c.slice(1)}`"
      @click="emit('update:colour', c)"
    />
    <template v-if="tool === 'mosaic' || tool === 'mosaic-brush'">
      <v-divider vertical class="mx-1" />
      <span class="text-caption mr-2">{{ t('editor.block') }}</span>
      <v-slider :model-value="block" :min="8" :max="48" :step="2" hide-details density="compact" class="block-slider" data-testid="mosaic-block" @update:model-value="(v: number) => emit('update:block', v)" />
    </template>
  </div>
</template>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgb(var(--v-theme-surface)); }
.swatch { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; margin: 0 2px; cursor: pointer; }
.swatch--on { border-color: rgb(var(--v-theme-on-surface)); box-shadow: 0 0 0 2px rgb(var(--v-theme-surface)) inset; }
.block-slider { width: 140px; flex: 0 0 140px; }
</style>
