<script setup lang="ts">
import { normalizeMatchPattern, type AppUrl } from '@yoda/shared'
import { validatePatternInput } from '~/utils/appUrls'

/**
 * A project's application URLs (Yoda Reporter URL mapping): members read; the PM or an admin edits. Every change
 * re-reads the list first and sends the whole list back, so another PM's change made meanwhile is kept.
 */
const props = defineProps<{ projectId: string; canManage: boolean }>()

const { t } = useI18n()
const api = useApi()
const urls = ref<AppUrl[]>([])
const loaded = ref(false)
const loadError = ref<unknown>(null)
const error = ref('')
const busy = ref(false)
/** Editing is offered only once the list is known: a change never starts from an empty or stale list. */
const editable = computed(() => props.canManage && loaded.value && !loadError.value)

const addOpen = ref(false)
const pattern = ref('')
const environment = ref('')
const production = ref(false)
const addError = ref('')
const removing = ref<AppUrl | null>(null)
const removeError = ref('')

const verdict = computed(() => validatePatternInput(pattern.value))
const duplicate = computed(() => urls.value.some((u) => u.pattern === normalizeMatchPattern(pattern.value)))
const patternError = computed(() => {
  if (!pattern.value.trim()) return ''
  if (verdict.value === 'invalid') return t('appUrls.invalid')
  if (verdict.value === 'too_broad') return t('appUrls.tooBroad')
  return duplicate.value ? t('appUrls.duplicate') : ''
})
const canAdd = computed(() => verdict.value === 'ok' && !duplicate.value)

const path = () => `/projects/${props.projectId}/app-urls`
let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<AppUrl[]>(path())
    if (mine !== seq) return
    urls.value = list
    loadError.value = null
  } catch (e) {
    if (mine === seq) loadError.value = e
  } finally {
    if (mine === seq) loaded.value = true
  }
}

type Row = { pattern: string; environment: string | null; production: boolean }
const rows = (list: AppUrl[]): Row[] => list.map(({ pattern, environment, production }) => ({ pattern, environment, production }))

/** Re-reads the list, applies `change` and saves the result; the error message, or null when saved. */
async function apply(change: (current: Row[]) => Row[] | string): Promise<string | null> {
  busy.value = true
  const mine = ++seq
  try {
    const current = rows(await api<AppUrl[]>(path()))
    const next = change(current)
    if (typeof next === 'string') return next
    const saved = await api<AppUrl[]>(path(), { method: 'PUT', body: { urls: next } })
    if (mine === seq) urls.value = saved
    return null
  } catch (e) {
    return t(errorKey(e))
  } finally {
    busy.value = false
  }
}

function openAdd() {
  pattern.value = ''
  environment.value = ''
  production.value = false
  addError.value = ''
  error.value = ''
  addOpen.value = true
}

async function add() {
  if (!canAdd.value || busy.value) return
  const row = { pattern: normalizeMatchPattern(pattern.value), environment: environment.value.trim() || null, production: production.value }
  const failed = await apply((current) => (current.some((u) => u.pattern === row.pattern) ? t('appUrls.duplicate') : [...current, row]))
  if (failed) addError.value = failed
  else addOpen.value = false
}

function askRemove(u: AppUrl) {
  removeError.value = ''
  removing.value = u
}

async function remove() {
  const u = removing.value
  if (!u || busy.value) return
  const failed = await apply((current) => current.filter((x) => x.pattern !== u.pattern))
  if (failed) removeError.value = failed
  else removing.value = null
}

onMounted(load)
</script>

<template>
  <div data-testid="app-urls-tab">
    <ErrorState v-if="loadError" :error="loadError" data-testid="app-urls-load-error" @retry="load" />
    <v-card v-else>
      <div class="card-head">
        <h2>{{ t('appUrls.title') }} <span class="count-pill ml-1">{{ urls.length }}</span></h2>
        <v-btn v-if="editable" color="primary" variant="tonal" size="small" prepend-icon="mdi-plus" data-testid="app-url-add" @click="openAdd">{{ t('appUrls.add') }}</v-btn>
      </div>
      <p class="card-body text-body-2 text-medium-emphasis mb-0">{{ t('appUrls.intro') }}</p>
      <v-alert v-if="error" type="error" variant="tonal" class="mx-4 mb-4" data-testid="app-urls-error">{{ error }}</v-alert>
      <p v-if="loaded && !urls.length" class="card-body text-medium-emphasis mb-0" data-testid="app-urls-empty">{{ t('appUrls.empty') }}</p>
      <ul v-else-if="urls.length" class="url-list" data-testid="app-urls">
        <li v-for="u in urls" :key="u.id" class="url-row" data-testid="app-url-row">
          <v-icon icon="mdi-web" size="20" class="text-medium-emphasis" aria-hidden="true" />
          <div class="url-row__main">
            <code class="url-row__pattern">{{ u.pattern }}</code>
            <div v-if="u.environment" class="text-caption text-medium-emphasis">{{ t('appUrls.environment') }}: {{ u.environment }}</div>
          </div>
          <StatusChip kind="appUrl" :value="u.production ? 'production' : 'test'" size="x-small" data-testid="app-url-kind" />
          <v-btn
            v-if="editable"
            variant="text"
            color="error"
            size="small"
            prepend-icon="mdi-delete-outline"
            :disabled="busy"
            data-testid="app-url-remove"
            @click="askRemove(u)"
          >{{ t('appUrls.remove') }}</v-btn>
        </li>
      </ul>
    </v-card>

    <AppDialog v-model="addOpen" :title="t('appUrls.addTitle')" size="form" :busy="busy" :dirty="!!pattern.trim()" data-testid="app-url-dialog">
      <v-alert v-if="addError" type="error" variant="tonal" density="compact" class="mb-4" data-testid="app-url-dialog-error">{{ addError }}</v-alert>
      <v-text-field
        v-model="pattern"
        :label="t('appUrls.pattern')"
        :hint="t('appUrls.patternHint')"
        :error-messages="patternError"
        persistent-hint
        autofocus
        spellcheck="false"
        autocapitalize="off"
        class="mb-2"
        data-testid="app-url-pattern"
        @keyup.enter="add"
      />
      <v-text-field v-model="environment" :label="t('appUrls.environment')" maxlength="100" data-testid="app-url-environment" />
      <v-switch v-model="production" color="error" inset :label="t('appUrls.production')" :hint="t('appUrls.productionHint')" persistent-hint data-testid="app-url-production" />
      <template #actions>
        <v-btn variant="text" :disabled="busy" data-testid="app-url-cancel" @click="addOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!canAdd" :loading="busy" data-testid="app-url-save" @click="add">{{ t('appUrls.add') }}</v-btn>
      </template>
    </AppDialog>

    <ConfirmDialog
      :model-value="!!removing"
      :title="t('appUrls.removeTitle')"
      :text="removing?.production ? t('appUrls.removeProductionText') : t('appUrls.removeText')"
      :confirm-label="t('appUrls.remove')"
      destructive
      :busy="busy"
      :error="removeError"
      confirm-testid="app-url-remove-ok"
      cancel-testid="app-url-remove-keep"
      @update:model-value="(v) => { if (!v) removing = null }"
      @confirm="remove"
    >
      <code v-if="removing" class="d-block mt-3 url-row__pattern">{{ removing.pattern }}</code>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.url-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.url-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; flex-wrap: wrap; }
.url-row + .url-row { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.url-row__main { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.url-row__pattern { font-size: .875rem; background: none; padding: 0; overflow-wrap: anywhere; }
</style>
