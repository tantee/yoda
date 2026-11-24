<script setup lang="ts">
import type { Project } from '@yoda/shared'

const { t } = useI18n()
const { me } = useMe()
const api = useApi()
const projects = ref<Project[]>([])
const loaded = ref(false)
const error = ref('')
const dialog = ref(false)
const form = reactive({ name: '', description: '' })

async function load() {
  try {
    projects.value = await api<Project[]>('/projects')
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function create() {
  error.value = ''
  try {
    const p = await api<Project>('/projects', { method: 'POST', body: { name: form.name, description: form.description } })
    dialog.value = false
    form.name = ''
    form.description = ''
    await navigateTo(`/projects/${p.id}`)
  } catch {
    error.value = t('common.error')
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('projects.title') }}</h1>
      <v-spacer />
      <v-btn v-if="me?.isAdmin" color="primary" prepend-icon="mdi-plus" @click="dialog = true">{{ t('projects.create') }}</v-btn>
    </div>
    <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>
    <p v-if="loaded && !projects.length" class="text-medium-emphasis">{{ t('projects.empty') }}</p>
    <v-list v-else-if="loaded" border>
      <v-list-item
        v-for="p in projects"
        :key="p.id"
        :to="`/projects/${p.id}`"
        :title="p.name"
        :subtitle="p.description"
      />
    </v-list>
    <v-dialog v-model="dialog" max-width="480">
      <v-card :title="t('projects.create')">
        <v-card-text>
          <v-text-field v-model="form.name" :label="t('projects.name')" autofocus />
          <v-textarea v-model="form.description" :label="t('projects.description')" rows="3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :disabled="!form.name.trim()" @click="create">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
