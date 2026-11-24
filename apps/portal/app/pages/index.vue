<script setup lang="ts">
import { homeFor } from '~/utils/nav'

const { me } = useMe()
await navigateTo(me.value ? homeFor(me.value) : '/requests', { replace: true })
</script>

<template><div /></template>
