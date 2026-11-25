// DEV ONLY: runs the in-memory FakeGitLab (test/fake-gitlab.ts) on a fixed port for trying GitLab features
// locally. Point the dev core at it with GITLAB_URL=http://127.0.0.1:<port> and any non-empty GITLAB_TOKEN.
// Never use it in production; it keeps everything in memory and accepts every token unless one is required.
//
//   pnpm --filter @yoda/core fake-gitlab
//   FAKE_GITLAB_PORT=4100 FAKE_GITLAB_PROJECTS=group/app,group/api pnpm --filter @yoda/core fake-gitlab
import { FakeGitLab } from './fake-gitlab.js'

const port = Number(process.env.FAKE_GITLAB_PORT ?? 4100)
const paths = (process.env.FAKE_GITLAB_PROJECTS ?? 'demo/app').split(',').map((p) => p.trim()).filter(Boolean)

const fake = new FakeGitLab()
await fake.start(port)
// Optional: make the fake reject any other token (an obvious placeholder, never a real one).
if (process.env.FAKE_GITLAB_TOKEN) fake.requireToken(process.env.FAKE_GITLAB_TOKEN)
// The fake hosts no git: a runner pushes to a local bare repo, so let MRs open from any branch.
if (process.env.FAKE_GITLAB_ANY_BRANCH) fake.acceptAnyBranch = true
for (const path of paths) {
  const p = fake.addProject(path)
  console.log(`fake-gitlab: project ${p.id} ${p.path_with_namespace}`)
}
console.log(`fake-gitlab: listening on ${fake.url} (DEV ONLY)`)

const stop = async () => {
  await fake.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
