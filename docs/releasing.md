# Releasing Yoda

For maintainers. Releases are published on GitHub: the images on `ghcr.io/tantee/yoda/<name>` (`core`, `portal`,
`runner`, `backup`) and the signed release bundle as the assets of a GitHub Release. `install.sh` downloads from
there by default. An internal mirror is optional ([below](#internal-mirror)).

- [What a release is](#what-a-release-is)
- [One-time setup](#one-time-setup)
- [Cut a release](#cut-a-release)
- [When a release run fails](#when-a-release-run-fails)
- [Dry runs](#dry-runs)
- [Verifying releases](#verifying-releases)
- [Pinned build inputs](#pinned-build-inputs)
- [Internal mirror](#internal-mirror)
- [Rotating the signing key](#rotating-the-signing-key)

## What a release is

A git tag `v<version>` on a commit of `main` (`v1.1.0`, `v1.2.0-rc.1`). The version without the `v` is the
release: `YODA_VERSION=1.1.0` on a host, the image tag, the `version` in `package.json` and
`apps/core/package.json`, and the `## 1.1.0 — <date>` section in `CHANGELOG.md`.

Only a pushed `v*` tag publishes anything. A pull request or a manual run (**Actions → Release → Run workflow**,
which has no options) is always a [dry run](#dry-runs).

The tag starts [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **meta** checks the tag (`v<x.y.z>` or `v<x.y.z>-<suffix>`), that the tagged commit is on `origin/main`, that
   `CHANGELOG.md` has a section for the version whose heading carries a date (not `unreleased`), and that
   `package.json` and `apps/core/package.json` both say that version. It fails before anything is built if any
   of these is wrong.
2. **images** builds each of the four images once per architecture, each on its own native runner
   (`ubuntu-24.04` for `linux/amd64`, `ubuntu-24.04-arm` for `linux/arm64`; no QEMU, whose emulated arm64
   builds hung the first v1.0.0 runs), without any build cache, and pushes them to ghcr.io **by digest only**: no
   tag yet. **manifest** then merges the two digests of each image into its multi-platform index
   (`.github/scripts/merge-image.sh`: `docker buildx imagetools create`), pushes that index by its digest only,
   reads it back and checks it lists exactly `linux/amd64` and `linux/arm64`. Each index digest is kept for the
   next job.
3. **bundle** runs `ops/install/bundle.sh`, which builds `yoda-<version>.tar.gz` (compose files, `deploy.sh`,
   `install.sh`, the built-in proxy's `ops/proxy/Caddyfile`, `.env.example`, `CHANGELOG.md`, the runbook and `bundle.env` with
   `YODA_IMAGE_PREFIX=ghcr.io/tantee/yoda`, `YODA_VERSION` and the four image digests), `install.sh` and
   `SHA256SUMS`. It signs `SHA256SUMS` with minisign, using the `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD`
   secrets and the trusted comment `yoda release <version>`. The job fails if either secret is missing or empty,
   if `install.sh` still has the placeholder key, or if the key in `install.sh` does not match the secret. It then
   serves the files from a local HTTP server and runs that `install.sh` against them with the key it embeds, as a
   host would, and checks that `release.env` and the compose files pin the pushed digests, that the optional
   built-in proxy runs a Caddy image pinned by version and digest, and that the bundle's Caddyfile passes
   `caddy validate` in it for each certificate mode (`ops/install/check-release.sh`).
4. **tag** checks the signed bundle's signature again, reads the digests from its `bundle.env` and only then
   tags those digests `<version>` and `sha-<short commit>` (`docker buildx imagetools create`), checking that
   each tag resolves to the signed digest. No `latest` tag: hosts always pin a version.
5. **release** creates the GitHub Release for the tag. Its notes are the `CHANGELOG.md` section
   (`ops/install/release-notes.sh`). The assets are `install.sh`, `yoda-<version>.tar.gz`, `SHA256SUMS` and
   `SHA256SUMS.minisig`. A version with a suffix (`-rc.1`, `-beta.2`) is marked as a pre-release.

A tag that cannot be signed therefore publishes no image tag and no release; the untagged digests it pushed are
never referenced.

**Never delete untagged versions of the ghcr.io packages** (no "delete untagged" cleanup, by hand, by a retention
policy or by an action). Hosts pull by digest: a version whose tag later moved, or a re-run's earlier digest, can
still be pinned in some host's `release.env`, and deleting it breaks that host's next pull, restart or restore. The jobs that sign or publish (**images**,
**manifest**, **bundle** on a release, **tag**, **release**) run in the `release` environment.

A host runs exactly the signed images: `deploy.sh` pins the bundle's digests in `release.env`
(`YODA_<NAME>_DIGEST`), and compose runs `<prefix>/<name>:<version>@<digest>`. Moving a tag later changes nothing
for an installed host.

## One-time setup

Steps 1 to 2 are **done**: the release key pair exists (key id `C73EF0AF404BAE84`) and its public half is
committed and embedded. The repository-level secrets are set too, but **step 3 is required before the first tag**:
move them into the `release` environment. Steps 4 and 5 remain as well.

1. **Make the signing key pair** (done) on a trusted machine, with a password (the workflow refuses an empty
   `MINISIGN_PASSWORD`, so the key must have one):

   ```bash
   minisign -G -p yoda.pub -s yoda.key
   ```

   `yoda.key` is the secret half. Keep it offline (an encrypted USB key or the organisation's password vault) and
   keep a backup copy. Nothing in the repository or the workflow stores it except the `release` environment's
   secret below.
2. **Publish the public key** (done). `yoda.pub` is committed as [`keys/yoda-release.pub`](../keys/yoda-release.pub),
   and its second line (it starts with `RW`) is in `ops/install/install.sh` (`RELEASE_PUBKEY_EMBEDDED='RW...'`)
   and in the verification snippets of the docs. The full list is under
   [rotating the signing key](#rotating-the-signing-key). Tests keep all of them equal to the key in
   `keys/yoda-release.pub`. `install.sh` refuses to run with a placeholder key (any value containing
   `REPLACE-WITH`), and the release job refuses to publish with one.
3. **Create the `release` environment and move the secrets into it** (required, owner). Settings →
   Environments → **New environment** `release`:
   - **Deployment branches and tags → Selected branches and tags → Add rule**, type **Tag**, pattern `v*`. Only a
     `v*` tag's run can then use the environment and its secrets; a pull request or a branch cannot.
   - Optionally add yourself as a **required reviewer**, so every release waits for one click.

   Then set the two secrets on the environment and delete the repository-level ones (the workflow reads the same
   names; an environment secret wins over a repository secret, so it works before and after the move):

   ```bash
   gh secret set --env release MINISIGN_SECRET_KEY < yoda.key
   gh secret set --env release MINISIGN_PASSWORD          # prompts; type the key's password
   gh secret delete MINISIGN_SECRET_KEY
   gh secret delete MINISIGN_PASSWORD
   gh secret list --env release                           # both names listed
   gh secret list                                         # neither listed
   ```

4. **Protect the tags** (required, owner): Settings → Rules → Rulesets → **New ruleset → New tag ruleset**,
   name `release tags`, enforcement **Active**, target **Include by pattern** `v*`, and the rules
   **Restrict creations**, **Restrict updates** and **Restrict deletions**, with the repository admins (or a
   maintainers team) in the **bypass list**. Only they can then create or move a `v*` tag, which is what the `release`
   environment trusts.
5. **After the first release, make the packages public.** GHCR creates `yoda/core`, `yoda/portal`, `yoda/runner`
   and `yoda/backup` as private packages on the first push. For each, open
   `https://github.com/users/tantee/packages/container/package/yoda%2F<name>` → Package settings:
   - **Danger zone → Change visibility → Public**, so hosts pull without `docker login`;
   - **Manage Actions access**: check that the `tantee/yoda` repository is listed with the **Write** role. The
     images carry `org.opencontainers.image.source`, which links each package to the repository. If a package
     is not linked, use **Connect repository**.

   Check it from a machine that is not logged in: `docker logout ghcr.io && docker pull ghcr.io/tantee/yoda/core:<version>`.
   Until then `install.sh` offers `docker login ghcr.io` when its pull fails.

## Cut a release

1. **Prepare the release commit** through a pull request to `main`:
   - `CHANGELOG.md`: the section is `## <version> — <date>`. Work in progress sits under `## Unreleased` (no
     version yet) or `## <version> — unreleased`; in this commit rename it to `## <version> — <date>` (the
     workflow refuses a tag whose version has no section, so an `## Unreleased` section is never published, and a
     heading that still says `unreleased`), and start a new `## Unreleased` above it later.
   - `version` in `package.json` and `apps/core/package.json` (core reports it on `/health`): both must equal the
     tag without the `v`, including a suffix (`1.1.0-rc.1`); the workflow refuses a mismatch.

   Merge it.
2. **Tag** the merge commit on `main` (the workflow refuses a commit that is not on `origin/main`) and push the
   tag:

   ```bash
   git switch main && git pull
   git tag -s v1.1.0 -m "Yoda 1.1.0"      # -s: a signed tag (needs a GPG or SSH signing key in git)
   git push origin v1.1.0
   ```

3. **Watch the workflow**: `gh run watch` (or Actions → Release). The multi-arch image builds take the longest.
   If a job fails, see [below](#when-a-release-run-fails).
4. **Check the release** from a clean machine with the published files:

   ```bash
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/install.sh
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/SHA256SUMS
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.1.0/SHA256SUMS.minisig
   out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
     printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.1.0' &&
     sha256sum --check --ignore-missing SHA256SUMS &&
     sh install.sh --version 1.1.0 --dir /tmp/yoda-check     # on a test host with Docker
   ```

   Each command runs only when the one before it passed; the `grep` checks that the signature is for this
   version. Then try the one-line install the README gives on a test host, once the release is the latest:
   `curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh -s -- --dir /tmp/yoda-one-line`. `release.env` in the install directory then lists the four digests, and
   `docker image ls --digests ghcr.io/tantee/yoda/core` shows the same one. The first release only: make the
   packages public first (one-time setup, step 5).

## When a release run fails

- **A job after meta failed for a passing reason** (a network error, a runner problem, GHCR or the release API
  down): open the run and use **Re-run failed jobs**. It runs the same commit and reuses what the finished jobs
  kept: the image digests and the signed bundle (artifacts, 7 days). Nothing is rebuilt or signed twice. Never
  start a new run by hand for this: a manual run is always a dry run.
- **The cause is in the repository** (the changelog, a version, the code): fix it on `main` through a pull
  request, delete the tag (`git push --delete origin v1.1.0 && git tag -d v1.1.0`) and tag the fixed commit. A
  failed run tagged no image and created no release, so nothing is left to clean up (leave its untagged
  digests: see above).
- **An image job ran out of time** (45 minutes, `timeout-minutes`): a build that slow is stuck, not busy; the
  images normally build in minutes. Re-running does not help: find the slow step in the job log, fix it through a
  pull request (whose dry run builds both architectures on the same native runners, so it shows there), then
  move the tag as above.
- **Only the release job failed after the images were tagged**: re-run failed jobs. If you must re-tag instead,
  the next run tags its own new digests, and installs pin whatever their bundle signed.

## Dry runs

A pull request that touches the release files (the workflow, `ops/install`, `ops/deploy`, `ops/backup`, the
Dockerfiles, the compose files or `CHANGELOG.md`) runs the same workflow as a dry run, and so does
**Actions → Release → Run workflow**. A dry run:

- builds the four images for `linux/amd64` and `linux/arm64` on the same native runners as a release, in the
  **images-dry** job, which has no `packages` permission, no registry login and pushes nothing; it may use the
  GitHub Actions build cache, which a release never reads. **manifest-dry** copies each image's two OCI archives
  into a throwaway registry on its own runner (checking their digests did not change) and merges them with the
  same script a release uses;
- builds the bundle as version `0.0.0-dryrun.<run number>` with those images' digests and signs it with a
  throwaway key made inside the job (never stored or uploaded), so it needs no secret, no environment, and
  works from forks;
- verifies the bundle end to end with `install.sh` against a local HTTP server, using that throwaway key, checks
  the digest pins in `release.env` and the compose files, and that a signature from any other key is refused. It
  runs `install.sh` twice: as a file next to the signed `SHA256SUMS`, and piped as the one-line install does
  (`cat install.sh | sh -s -- …`, no `--version`: the latest release from a `releases/latest` redirect the local
  server answers like GitHub's, then `SHA256SUMS` and its signature downloaded);
- runs the README's one-line install on a fresh `ubuntu:24.04` (job **one-line-install**, a privileged container
  with only curl, ca-certificates and sudo, as a user with sudo): `curl … | sh -s -- --yes` against the dry run's
  bundle served on the runner. It checks that `install.sh` reports minisign, Docker and Compose missing, installs
  minisign from apt and Docker from Docker's apt repository (Compose 2.24 or later), stops at the daemon (no
  systemd); then, with `dockerd` started by hand, that it verifies the release, creates `/srv/yoda` with sudo for
  that user and unpacks it, and stops at the image pull, because a dry run's images are never pushed;
- checks that the newest `CHANGELOG.md` section extracts as notes;
- creates no release and no image tag. Its only artifacts are the four one-line digest files, kept for a day;
  no build record is uploaded (`DOCKER_BUILD_RECORD_UPLOAD=false`).

## Verifying releases

Every release's `SHA256SUMS` is signed with the Yoda release key:

- key id: `C73EF0AF404BAE84`
- public key: `RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j`
- where it lives: [`keys/yoda-release.pub`](../keys/yoda-release.pub) in this repository, and built into
  `ops/install/install.sh` (`RELEASE_PUBKEY_EMBEDDED`), which checks every download with it.

Check a release by hand (in the directory holding the downloaded assets; `1.1.0` is the version you downloaded):

```bash
out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
  printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.1.0' &&
  sha256sum --check --ignore-missing SHA256SUMS
```

`minisign` prints `Trusted comment: yoda release <version>` only for a valid signature, and the `grep` fails
unless it names the version you downloaded (an older signed `SHA256SUMS` cannot pass for a newer release). With
the repository checked out, `minisign -Vm SHA256SUMS -p keys/yoda-release.pub` does the same check of the
signature. The image digests a release runs are in its bundle: `tar -xzOf yoda-1.1.0.tar.gz bundle.env`.

## Pinned build inputs

Everything a release build pulls is pinned, so a moved upstream tag cannot change a release:

| What | Where | Pinned as |
| --- | --- | --- |
| GitHub Actions | `.github/workflows/release.yml` | full commit SHA, `# v<x.y.z>` comment |
| BuildKit | `release.yml`, `setup-buildx-action` `driver-opts` | `moby/buildkit:<tag>@sha256:…` |
| Registry (dry run only, the throwaway registry of **manifest-dry**) | `release.yml`, `services.registry.image` | `registry:<exact tag>@sha256:…` |
| Base images | `apps/core/Dockerfile`, `apps/portal/Dockerfile`, `apps/runner/Dockerfile`, `ops/backup/Dockerfile` | `FROM <image>:<exact tag>@sha256:…` |
| Ubuntu (dry run only, the fresh host of **one-line-install**) | `release.yml`, job `one-line-install`, `UBUNTU_IMAGE` | `ubuntu:24.04@sha256:…` (the multi-platform index; look it up with `curl -fsSL https://hub.docker.com/v2/repositories/library/ubuntu/tags/24.04` and read `.digest`) |
| Caddy (the optional built-in HTTPS proxy, [runbook 4b](operations.md#4b-built-in-https-proxy-optional)) | `docker-compose.prod.yml`, service `proxy`, `image` | `caddy:<exact tag>@sha256:…` (the multi-platform index) |

The tag stays next to each digest for reading; the digest is what is pulled. To bump one, pick the new exact tag,
look up its digest and replace both together, in a pull request (its dry run builds with the new inputs):

```bash
docker buildx imagetools inspect node:22.23.5-alpine --format '{{json .Manifest}}' | jq -r .digest
docker buildx imagetools inspect moby/buildkit:v0.35.1 --format '{{json .Manifest}}' | jq -r .digest
gh api repos/docker/setup-buildx-action/git/ref/tags/v4.4.1 --jq .object.sha   # an action's commit (annotated tags: follow .object)
```

**Caddy.** It is pulled on the deploy hosts, not built, so the release images do not change with it, but the
signed bundle carries the compose file that names it. Take a Caddy release at least two weeks old with no open
security advisory against it, then:

```bash
docker buildx imagetools inspect caddy:2.11.4 --format '{{json .Manifest}}' | jq -r .digest   # the index digest
```

Replace both the tag and the digest of the `proxy` service's `image`. In the pull request,
`apps/core/test/ops-proxy.test.ts` runs `caddy validate` on `ops/proxy/Caddyfile` in the new image for every
certificate mode (CI, with docker), and the release dry run's `check-release.sh` does it again on the bundle,
with the environment compose gives the proxy service (empty values included). Read Caddy's release notes for changes to the Caddyfile, `tls internal`, or the `X-Forwarded-*` defaults
(section 4b of the runbook relies on them), and do one container run with the proxy (internal mode) before
merging a minor or major bump.

`node:22-alpine` and `node:22-slim` follow the `.nvmrc` major (22); `postgres` in the backup image follows the
server's major (17, `pgvector/pgvector:pg17` in `docker-compose.yml`).

## Internal mirror

Hosts that cannot reach GitHub or ghcr.io install from a mirror inside the network. `install.sh` takes the
release's directory and the image registry path:

```bash
sh install.sh --version 1.1.0 --dir /srv/yoda \
  --base-url 'https://files.example.org/yoda/releases/{version}/' \
  --image-prefix registry.example.org/group/yoda
```

`{version}` in `--base-url` becomes the version; a URL without it is used as the release's directory as is. The
same settings work as `YODA_RELEASE_BASE_URL` and `YODA_IMAGE_PREFIX`. For a registry other than ghcr.io,
`install.sh` asks for a `docker login` when the host has none saved.

Two ways to fill the mirror:

- **Copy the published release.** Put the four GitHub Release assets in one directory per version on any static
  HTTPS server, and copy the images with their manifests, for example
  `docker buildx imagetools create -t registry.example.org/group/yoda/core:1.1.0 ghcr.io/tantee/yoda/core:1.1.0`
  for each of the four images, or set the registry up as a pull-through cache of ghcr.io. The signature stays
  valid, because the files are unchanged. Copied images keep their digests (a digest names content, not a
  registry), so a host given the mirror's `--image-prefix` still runs the digests the signed bundle pins. A mirror
  whose registry rebuilt the images has other digests: the pull fails, closed; install or deploy there with
  `YODA_IGNORE_BUNDLE_DIGESTS=1` to run its tags (it warns).
- **Build it in GitLab CI.** `.gitlab-ci.yml` builds the images into the project's registry and, on tags, the
  signed bundle (`release-bundle` job), without digests. It uploads the bundle to the file server under
  `releases/<version>/`. A mirrored GitHub tag `v1.1.0` becomes release `1.1.0` there. Its CI/CD variables are
  YODA_RELEASE_SIGNING_KEY (type File: the same `yoda.key`), YODA_RELEASE_SIGNING_PASSWORD (masked) and
  YODA_RELEASE_UPLOAD_URL and YODA_RELEASE_UPLOAD_TOKEN; see the [runbook, section 5](operations.md#5-upgrade-and-rollback).
  The GitLab pipeline also has the manual `deploy` job.

## Rotating the signing key

Make a new pair as in the one-time setup (`minisign -G -p yoda.pub -s yoda.key`), then replace the public key
everywhere it appears, in one pull request:

- `keys/yoda-release.pub` (the whole file, both lines);
- `ops/install/install.sh`: `RELEASE_PUBKEY_EMBEDDED` and the key id in the comment above it and in the
  `YODA_RELEASE_PUBKEY` warning;
- the key after `-P` in the verification snippets, and the key id, in `README.md`, `docs/guides/install.md`,
  `docs/operations.md` (sections 4 and 5) and this file (cut a release, verifying releases, one-time setup);
- the `.gitleaks.toml` allowlist entry for the public key;
- the key id the tests expect (`apps/core/test/ops-install.test.ts`).

Then set the secrets of the `release` environment again (`gh secret set --env release MINISIGN_SECRET_KEY <
yoda.key`, `gh secret set --env release MINISIGN_PASSWORD`), and the GitLab mirror's YODA_RELEASE_SIGNING_KEY and
YODA_RELEASE_SIGNING_PASSWORD if you run it, and cut the next release. Installs made with an older `install.sh`
are not affected: the script only runs once, at install time, and upgrades go through `deploy.sh`. Older
releases stay signed with the old key, so keep publishing the old public key (for example as
`keys/yoda-release-<old key id>.pub`) for anyone who checks them later.
