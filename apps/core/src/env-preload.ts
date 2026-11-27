/**
 * Imported first by every entry point that loads the AI SDK (server, yoda-admin), before any other module.
 *
 * `@ai-sdk/openai` and `@ai-sdk/anthropic` build a default provider when they are imported, and that reads
 * OPENAI_BASE_URL / ANTHROPIC_BASE_URL from the environment: an empty value throws ("baseURL must be a non-empty
 * string") and core never starts. The prod compose passes every UI-editable setting as `${VAR:-}` (empty = unset,
 * editable in System settings), so drop those empty values here. The bundle keeps this file separate (build.mjs),
 * so it is evaluated before the externals the bundle imports.
 */
for (const name of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']) {
  if (process.env[name]?.trim() === '') delete process.env[name]
}
export {}
