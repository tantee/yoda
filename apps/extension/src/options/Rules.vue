<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Rule } from '../rules/match'
import type { Profile } from '../sw/store'

/** URL mapping: every rule by source (only mine editable), the URL tester, and the add/edit dialog. */
const props = defineProps<{ profiles: Profile[] }>()
const { t } = useI18n()
const rules = ref<Rule[]>([])
const projects = ref<Record<string, { id: string; name: string }[]>>({})
const testUrl = ref('')
const tested = ref<{ rule: Rule; why: string[] } | null | undefined>(undefined)
const editing = ref<{ id?: string; pattern: string; profileId: string; projectId: string | null; environment: string } | null>(null)
const errors = ref<string[]>([])

const SOURCE_ORDER = { policy: 0, yoda: 1, mine: 2 } as const
const sorted = computed(() => [...rules.value].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.order - b.order))
const profileName = (id: string) => props.profiles.find((p) => p.id === id)?.name ?? '—'
const projectName = (r: Rule) => (r.projectId ? (projects.value[r.profileId]?.find((p) => p.id === r.projectId)?.name ?? r.projectId.slice(0, 8)) : t('options.fromBuild'))

async function load(refresh = false) {
  const r = (await chrome.runtime.sendMessage({ type: 'rules.list', refresh })) as { ok: boolean; rules?: Rule[] }
  rules.value = r?.rules ?? []
  for (const p of props.profiles.filter((x) => !x.needsReconnect)) {
    const s = (await chrome.runtime.sendMessage({ type: 'session.get', profileId: p.id })) as { ok: boolean; session?: { projects: { id: string; name: string }[] } }
    if (s?.ok && s.session) projects.value = { ...projects.value, [p.id]: s.session.projects }
  }
}

async function test() {
  if (!testUrl.value.trim()) return (tested.value = undefined)
  const r = (await chrome.runtime.sendMessage({ type: 'mapping.test', url: testUrl.value.trim() })) as { ok: boolean; picked?: { rule: Rule; why: string[] } | null }
  tested.value = r?.picked ?? null
}

function add() {
  errors.value = []
  editing.value = { pattern: '', profileId: props.profiles.find((p) => p.isDefault)?.id ?? props.profiles[0]?.id ?? '', projectId: null, environment: '' }
}

function edit(r: Rule) {
  errors.value = []
  editing.value = { id: r.id, pattern: r.pattern, profileId: r.profileId, projectId: r.projectId, environment: r.environment ?? '' }
}

async function save() {
  if (!editing.value) return
  const e = editing.value
  const r = (await chrome.runtime.sendMessage({ type: 'rules.saveMine', rule: { ...e, environment: e.environment || null } })) as { ok: boolean; errors?: string[] }
  if (!r?.ok) return (errors.value = r?.errors ?? ['pattern_invalid'])
  editing.value = null
  await load()
  await test()
}

async function remove(r: Rule) {
  await chrome.runtime.sendMessage({ type: 'rules.deleteMine', id: r.id })
  await load()
  await test()
}

watch(() => props.profiles, () => void load(), { deep: true })
onMounted(() => void load(true))
</script>

<template>
  <v-card variant="outlined" data-testid="rules">
    <div class="rules__head">
      <h2 class="text-subtitle-1 font-weight-bold">{{ t('options.rules') }}</h2>
      <span class="text-caption text-medium-emphasis">{{ t('options.rulesHint') }}</span>
      <v-spacer />
      <v-btn variant="outlined" size="small" prepend-icon="mdi-plus" :disabled="!profiles.length" data-testid="rule-add" @click="add">{{ t('options.addRule') }}</v-btn>
    </div>
    <div class="rules__tester">
      <v-text-field v-model="testUrl" :label="t('options.tester')" density="compact" hide-details placeholder="https://appt-uat.example.org/opd/queue" data-testid="tester-url" @update:model-value="test" />
      <div class="text-body-2 mt-2" data-testid="tester-result">
        <template v-if="tested === null"><v-icon icon="mdi-help-circle-outline" size="16" /> {{ t('options.testerNone') }}</template>
        <template v-else-if="tested">
          <v-icon icon="mdi-check-circle" color="success" size="16" />
          {{ t('options.testerMatch', { yoda: profileName(tested.rule.profileId), project: projectName(tested.rule), n: sorted.findIndex((r) => r.id === tested!.rule.id) + 1 }) }}
          <ul class="rules__why text-caption text-medium-emphasis" data-testid="tester-why">
            <li v-for="w in tested.why" :key="w">{{ w }}</li>
          </ul>
        </template>
      </div>
    </div>
    <v-table density="comfortable" class="rules__table">
      <thead>
        <tr>
          <th>#</th>
          <th>{{ t('options.pattern') }}</th>
          <th>{{ t('options.yoda') }}</th>
          <th>{{ t('options.project') }}</th>
          <th>{{ t('options.environment') }}</th>
          <th>{{ t('options.source') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-if="!sorted.length"><td colspan="7" class="text-medium-emphasis" data-testid="rules-empty">{{ t('options.noRules') }}</td></tr>
        <tr v-for="(r, i) in sorted" :key="r.id" :class="{ 'rules__row--hit': tested && tested.rule.id === r.id }" :data-testid="`rule-${r.source}`">
          <td>{{ i + 1 }}</td>
          <td class="rules__pattern">{{ r.pattern }}</td>
          <td>{{ profileName(r.profileId) }}</td>
          <td>{{ projectName(r) }}</td>
          <td>
            <span v-if="r.production" class="text-error"><v-icon icon="mdi-alert-circle-outline" size="14" /> {{ t('options.production') }}</span>
            <span v-else>{{ r.environment ?? '' }}</span>
          </td>
          <td><v-chip size="x-small" :variant="r.source === 'mine' ? 'outlined' : 'tonal'" :color="r.source === 'yoda' ? 'primary' : undefined">{{ t(`options.sourceName.${r.source}`) }}</v-chip></td>
          <td class="text-right">
            <template v-if="r.source === 'mine'">
              <v-btn variant="text" size="small" :data-testid="`rule-edit-${i}`" @click="edit(r)">{{ t('options.editRule') }}</v-btn>
              <v-btn variant="text" size="small" color="error" icon="mdi-delete-outline" :aria-label="t('common.remove')" @click="remove(r)" />
            </template>
            <v-icon v-else icon="mdi-lock-outline" size="16" :title="t('options.locked', { s: t(`options.sourceName.${r.source}`) })" />
          </td>
        </tr>
      </tbody>
    </v-table>
    <v-alert type="info" variant="tonal" density="compact" class="ma-3">{{ t('options.rulesInfo') }}</v-alert>

    <v-dialog :model-value="!!editing" max-width="520" @update:model-value="(v: boolean) => !v && (editing = null)">
      <v-card v-if="editing" data-testid="rule-dialog">
        <v-card-title>{{ editing.id ? t('options.editRule') : t('options.addRule') }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="editing.pattern" :label="t('options.pattern')" :hint="t('options.patternHint')" persistent-hint class="mb-3" data-testid="rule-pattern" />
          <v-select v-model="editing.profileId" :items="profiles" item-title="name" item-value="id" :label="t('options.yoda')" class="mb-1" data-testid="rule-profile" />
          <v-select
            v-model="editing.projectId"
            :items="[{ id: null, name: t('options.fromBuild') }, ...(projects[editing.profileId] ?? [])]"
            item-title="name"
            item-value="id"
            :label="t('options.project')"
            class="mb-1"
            data-testid="rule-project"
          />
          <v-text-field v-model="editing.environment" :label="t('options.environment')" maxlength="100" data-testid="rule-environment" />
          <v-alert v-for="e in errors" :key="e" type="error" variant="tonal" density="compact" class="mt-2" data-testid="rule-error">{{ t(`options.ruleError.${e}`) }}</v-alert>
        </v-card-text>
        <v-card-actions class="justify-end">
          <v-btn variant="text" @click="editing = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" data-testid="rule-save" @click="save">{{ t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.rules__head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; flex-wrap: wrap; }
.rules__tester { padding: 0 16px 12px; }
.rules__why { margin: 4px 0 0 20px; }
.rules__pattern { font-family: ui-monospace, monospace; font-size: 13px; }
.rules__row--hit { background: rgba(var(--v-theme-primary), 0.06); box-shadow: inset 3px 0 0 rgb(var(--v-theme-primary)); }
.rules__table { overflow-x: auto; }
</style>
