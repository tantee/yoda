<script setup lang="ts">
/** The product mark. A neutral placeholder for now; Task 9 swaps in the original mark here. */
withDefaults(defineProps<{ size?: number }>(), { size: 30 })
</script>

<template>
  <span class="app-mark" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size / 2)}px` }" aria-hidden="true" data-testid="app-mark">Y</span>
</template>

<style scoped>
.app-mark {
  display: inline-grid; place-items: center; flex: none; border-radius: 7px;
  background: #fff; color: rgb(var(--v-theme-nav)); font-family: 'IBM Plex Sans', sans-serif; font-weight: 600; line-height: 1;
}
</style>
