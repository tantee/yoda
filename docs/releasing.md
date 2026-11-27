# Releasing Yoda

For maintainers. Releases are published on GitHub: the images on `ghcr.io/tantee/yoda/<name>` (`core`, `portal`,
`runner`, `backup`) and the signed release bundle as the assets of a GitHub Release. `install.sh` downloads from
there by default. An internal mirror is optional ([below](#internal-mirror)).

- [What a release is](#what-a-release-is)
- [One-time setup](#one-time-setup)
- [Cut a release](#cut-a-release)
- [Dry runs](#dry-runs)
- [Verifying releases](#verifying-releases)
- [Internal mirror](#internal-mirror)
- [Rotating the signing key](#rotating-the-signing-key)

## What a release is

A git tag `v<version>` on `main` (`v1.0.0`, `v1.1.0-rc.1`). The version without the `v` is the release:
`YODA_VERSION=1.0.0` on a host, the image tag, and the `## 1.0.0 — <date>` section in `CHANGELOG.md`.

The tag starts [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **meta** checks the tag (`v<x.y.z>` or `v<x.y.z>-<suffix>`) and that `CHANGELOG.md` has a section for the
   version. It fails before anything is built if either is wrong.
2. **bundle** runs `ops/install/bundle.sh`, which builds `yoda-<version>.tar.gz` (compose files, `deploy.sh`,
   `install.sh`, `.env.example`, `CHANGELOG.md`, the runbook and `bundle.env` with
   `YODA_IMAGE_PREFIX=ghcr.io/tantee/yoda` and `YODA_VERSION`), `install.sh` and `SHA256SUMS`. It signs
   `SHA256SUMS` with minisign, using the `MINISIGN_SECRET_KEY` secret and the trusted comment `yoda release
   <version>`. The job fails if the secret is missing, if `install.sh` still has the placeholder key, or if the key
   in `install.sh` does not match the secret. It then serves the files from a local HTTP server and runs that
   `install.sh` against them with the key it embeds, as a host would (`ops/install/check-release.sh`).
3. **images** builds the four images for `linux/amd64` and `linux/arm64` (QEMU) and pushes them tagged
   `<version>` and `sha-<short commit>`. No `latest` tag: hosts always pin a version. This job runs only after the
   bundle is signed and verified, so a tag that cannot be signed publishes nothing.
4. **release** creates the GitHub Release for the tag. Its notes are the `CHANGELOG.md` section
   (`ops/install/release-notes.sh`). The assets are `install.sh`, `yoda-<version>.tar.gz`, `SHA256SUMS` and
   `SHA256SUMS.minisig`. A version with a suffix (`-rc.1`, `-beta.2`) is marked as a pre-release.

## One-time setup

Steps 1 to 3 are **done**: the release key pair exists (key id `C73EF0AF404BAE84`), its public half is committed
and embedded, and the repository secrets are set. They are kept here for a fork, a mirror with its own key, or a
key rotation. Steps 4 and 5 remain.

1. **Make the signing key pair** (done) on a trusted machine, with a password:

   ```bash
   minisign -G -p yoda.pub -s yoda.key
   ```

   `yoda.key` is the secret half. Keep it offline (an encrypted USB key or the organisation's password vault) and
   keep a backup copy. Nothing in the repository or the workflow stores it except the repository secret below.
2. **Publish the public key** (done). `yoda.pub` is committed as [`keys/yoda-release.pub`](../keys/yoda-release.pub),
   and its second line (it starts with `RW`) is in:
   - `ops/install/install.sh`: `RELEASE_PUBKEY_EMBEDDED='RW...'`;
   - the `-P` key of the `minisign -Vm SHA256SUMS` snippets in `README.md`, [the install guide](guides/install.md) and
     the runbook.

   Tests keep all of them equal to the key in `keys/yoda-release.pub`. A fork or mirror with its own key
   replaces every one of them. `install.sh` refuses to run with a placeholder key (any value containing
   `REPLACE-WITH`), and the release job refuses to publish with one.
3. **Set the repository secrets** (done; Settings → Secrets and variables → Actions, or the CLI). The workflow
   reads exactly these two names:

   ```bash
   gh secret set MINISIGN_SECRET_KEY < yoda.key
   gh secret set MINISIGN_PASSWORD          # prompts; type the key's password
   ```

4. **Protect the tags** (optional but recommended): Settings → Rules → Rulesets → a tag ruleset for `v*` that
   only maintainers may create, update or delete.
5. **After the first release, make the packages public.** GHCR creates `yoda/core`, `yoda/portal`, `yoda/runner`
   and `yoda/backup` as private packages on the first push. For each, open
   `https://github.com/users/tantee/packages/container/package/yoda%2F<name>` → Package settings:
   - **Danger zone → Change visibility → Public**, so hosts pull without `docker login`;
   - **Manage Actions access**: check that the `tantee/yoda` repository is listed with the **Write** role. The
     images carry `org.opencontainers.image.source`, which links each package to the repository. If a package
     is not linked, use **Connect repository**.

   Check it from a machine that is not logged in: `docker logout ghcr.io && docker pull ghcr.io/tantee/yoda/core:<version>`.

## Cut a release

1. **Changelog.** Rename `## Unreleased` to `## <version> — <date>` (add a new empty `## Unreleased` above it if
   you like) and bump `version` in `package.json` and `apps/core/package.json` (core reports it on `/health`).
   Merge that through a pull request.
2. **Tag** the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -s v1.0.0 -m "Yoda 1.0.0"      # -s: a signed tag (needs a GPG or SSH signing key in git)
   git push origin v1.0.0
   ```

3. **Watch the workflow**: `gh run watch` (or Actions → Release). The multi-arch image builds take the longest.
   If it fails before the **release** job, fix the cause on `main` and tag again: delete the tag first
   (`git push --delete origin v1.0.0 && git tag -d v1.0.0`). Images may already be pushed by then; the new run
   overwrites the same tags.
4. **Check the release** from a clean machine with the published files:

   ```bash
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/install.sh
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/SHA256SUMS
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.0.0/SHA256SUMS.minisig
   minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j && sha256sum --check --ignore-missing SHA256SUMS
   sh install.sh --version 1.0.0 --dir /tmp/yoda-check     # on a test host with Docker
   ```

   The first release only: make the packages public first (one-time setup, step 5).

## Dry runs

A pull request that touches the release files (the workflow, `ops/install`, `ops/deploy`, `ops/backup`, the
Dockerfiles, the compose files or `CHANGELOG.md`) runs the same workflow as a dry run, and so does
**Actions → Release → Run workflow** with **Dry run** checked. A dry run:

- builds the four images for `linux/amd64` only and pushes nothing;
- builds the bundle as version `0.0.0-dryrun.<run number>` and signs it with a throwaway key made inside the job
  (never stored or uploaded), so it needs no secret and works from forks;
- verifies the bundle end to end with `install.sh` against a local HTTP server, using that throwaway key, and
  checks that a signature from any other key is refused;
- checks that the newest `CHANGELOG.md` release section extracts as notes;
- creates no release and uploads no artifact.

A manual run with **Dry run** unchecked on a `v*` tag reruns a real release (for example after a failure in the
**release** job). Without a tag it fails.

## Verifying releases

Every release's `SHA256SUMS` is signed with the Yoda release key:

- key id: `C73EF0AF404BAE84`
- public key: `RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j`
- where it lives: [`keys/yoda-release.pub`](../keys/yoda-release.pub) in this repository, and built into
  `ops/install/install.sh` (`RELEASE_PUBKEY_EMBEDDED`), which checks every download with it.

Check a release by hand (in the directory holding the downloaded assets):

```bash
minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j
sha256sum --check --ignore-missing SHA256SUMS
```

`minisign` prints `Trusted comment: yoda release <version>`; the version must be the one you downloaded. With
the repository checked out, `minisign -Vm SHA256SUMS -p keys/yoda-release.pub` does the same.

## Internal mirror

Hosts that cannot reach GitHub or ghcr.io install from a mirror inside the network. `install.sh` takes the
release's directory and the image registry path:

```bash
sh install.sh --version 1.0.0 --dir /srv/yoda \
  --base-url 'https://files.example.org/yoda/releases/{version}/' \
  --image-prefix registry.example.org/group/yoda
```

`{version}` in `--base-url` becomes the version; a URL without it is used as the release's directory as is. The
same settings work as `YODA_RELEASE_BASE_URL` and `YODA_IMAGE_PREFIX`. For a registry other than ghcr.io,
`install.sh` asks for a `docker login` when the host has none saved.

Two ways to fill the mirror:

- **Copy the published release.** Put the four GitHub Release assets in one directory per version on any static
  HTTPS server, and copy the images with their manifests, for example
  `docker buildx imagetools create -t registry.example.org/group/yoda/core:1.0.0 ghcr.io/tantee/yoda/core:1.0.0`
  for each of the four images, or set the registry up as a pull-through cache of ghcr.io. The signature stays
  valid, because the files are unchanged.
- **Build it in GitLab CI.** `.gitlab-ci.yml` builds the images into the project's registry and, on tags, the
  signed bundle (`release-bundle` job). It uploads the bundle to the file server under `releases/<version>/`. A
  mirrored GitHub tag `v1.0.0` becomes release `1.0.0` there. Its CI/CD variables are YODA_RELEASE_SIGNING_KEY
  (type File: the same `yoda.key`), YODA_RELEASE_SIGNING_PASSWORD (masked) and YODA_RELEASE_UPLOAD_URL and
  YODA_RELEASE_UPLOAD_TOKEN; see the [runbook, section 5](operations.md#5-upgrade-and-rollback). The GitLab
  pipeline also has the manual `deploy` job.

## Rotating the signing key

Make a new pair as in the one-time setup, embed the new public key in `install.sh` and the README, set the two
secrets again, and cut the next release. Installs made with an older `install.sh` are not affected: the script
only runs once, at install time, and upgrades go through `deploy.sh`. Older releases stay signed with the old
key, so keep publishing the old public key for anyone who checks them later.
