/**
 * zxcvbn (pinned @zxcvbn-ts/core and @zxcvbn-ts/language-common), loaded on demand by the /setup admin step only:
 * a dynamic `import()`, so its dictionaries are separate chunks and never part of the portal's main bundle. Until
 * it is in (or if it cannot load), the wizard uses the small estimator in utils/setup.ts. Core keeps its own
 * minimum either way (`passwordIssue`).
 */
export type Scorer = (password: string, userInputs: string[]) => 0 | 1 | 2 | 3 | 4

let loading: Promise<Scorer> | null = null

export function loadZxcvbn(): Promise<Scorer> {
  loading ??= (async () => {
    const [{ zxcvbn, zxcvbnOptions }, common] = await Promise.all([import('@zxcvbn-ts/core'), import('@zxcvbn-ts/language-common')])
    zxcvbnOptions.setOptions({ graphs: common.adjacencyGraphs, dictionary: { ...common.dictionary } })
    return (password: string, userInputs: string[]) => zxcvbn(password, userInputs).score as 0 | 1 | 2 | 3 | 4
  })().catch((err) => {
    loading = null
    throw err
  })
  return loading
}
