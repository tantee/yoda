<script setup lang="ts">
import { renderMarkdown } from '~/utils/markdown'

const props = defineProps<{ source: string }>()
// markdown-it runs with html disabled, so this is the one place v-html is allowed.
const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-view" data-testid="markdown" v-html="html" />
</template>

<style scoped>
.markdown-view :deep(p),
.markdown-view :deep(ul),
.markdown-view :deep(ol),
.markdown-view :deep(pre),
.markdown-view :deep(blockquote) { margin-bottom: 0.75rem; }
.markdown-view :deep(ul),
.markdown-view :deep(ol) { padding-left: 1.5rem; }
.markdown-view :deep(h1),
.markdown-view :deep(h2),
.markdown-view :deep(h3) { margin: 0.75rem 0 0.5rem; font-weight: 500; }
.markdown-view :deep(pre) { overflow-x: auto; padding: 0.5rem; background: rgba(128, 128, 128, 0.12); border-radius: 4px; }
.markdown-view :deep(code) { background: rgba(128, 128, 128, 0.12); padding: 0 0.25rem; border-radius: 3px; }
.markdown-view :deep(pre code) { background: none; padding: 0; }
.markdown-view :deep(blockquote) { border-left: 3px solid rgba(128, 128, 128, 0.4); padding-left: 0.75rem; }
.markdown-view :deep(table) { border-collapse: collapse; }
.markdown-view :deep(th),
.markdown-view :deep(td) { border: 1px solid rgba(128, 128, 128, 0.4); padding: 0.25rem 0.5rem; }
</style>
