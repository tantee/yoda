#!/bin/sh
# Deploys one release on the deploy host, from the directory holding docker-compose.yml, docker-compose.prod.yml
# and the host's .env. The GitLab `deploy` job copies this file there and runs it; install.sh runs it for the
# first install; by hand (also to roll back): cd <deploy path> && YODA_VERSION=<tag> sh ops/deploy/deploy.sh
#
# 0. create an empty .env (0600) when there is none: nothing in it is required (the `init` service generates the
#    bootstrap values, the setup wizard sets the rest); an existing .env is never changed;
# 1. pull the release's images (nothing is built on the host), then pin the release in release.env
#    (YODA_VERSION=<tag>, plus YODA_IMAGE_PREFIX when given or already pinned there; with no prefix in the
#    environment, release.env or .env it uses the public release images, ghcr.io/tantee/yoda, never Docker Hub;
#    plus the image digests, YODA_<NAME>_DIGEST, when the bundle.env next to it is the same release's and names
#    the same prefix: the signed bundle's pins), so every later
#    `docker compose --env-file .env --env-file release.env ...` on the host (backups, restores, restarts) runs
#    the same images; exit 3 when the images cannot be pulled (registry login?);
# 2. fill the bootstrap volume (one-shot `init`: generated Postgres password, RustFS keys and master key, or the
#    .env values when set; it refuses an existing database whose password is unknown), then run the database
#    migrations once, in the one-shot `migrate` container; a failure stops here, before any running container is
#    replaced;
# 3. start or replace the services;
# 4. wait up to READY_TIMEOUT seconds (120) for the portal's /api/ready (portal -> core: database, storage,
#    job queue); exit 1 otherwise;
# 5. when core's /public-config says setup is still required, print where the setup wizard is and how to get
#    the setup token.
# It never removes or recreates a volume (the bootstrap volume holds the master key).
set -eu

: "${YODA_VERSION:?YODA_VERSION (the release tag) is required}"
case "$YODA_VERSION" in
  '' | -* | *[!A-Za-z0-9._-]*)
    echo "deploy: invalid YODA_VERSION" >&2
    exit 2
    ;;
esac
# Optional: the registry path of the images; pinned in release.env with the version.
prefix="${YODA_IMAGE_PREFIX:-}"
case "$prefix" in
  -* | *[!A-Za-z0-9._:/-]*)
    echo "deploy: invalid YODA_IMAGE_PREFIX" >&2
    exit 2
    ;;
esac
if [ -z "$prefix" ] && [ -f release.env ]; then
  prefix=$(sed -n 's/^YODA_IMAGE_PREFIX=\([A-Za-z0-9._:/-]*\)$/\1/p' release.env | tail -n 1)
fi
# The prod compose has no default prefix: without one it would pull `yoda/...` from Docker Hub. An install from
# before install.sh keeps its prefix in .env (release.env, when it holds one, wins over .env).
# As compose reads .env: the last line wins, surrounding quotes go, and an unquoted value ends at ' #'.
env_prefix() {
  [ -f .env ] || return 0
  sed -n 's/^[[:space:]]*YODA_IMAGE_PREFIX[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | sed \
    -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\\([^']*\\)'.*\$/\\1/" -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//'
}
legacy=$(env_prefix)
case "$legacy" in
  '' | -* | *[!A-Za-z0-9._:/-]*) legacy='' ;;
esac
# The public release images (docs/releasing.md); a mirror passes or pins its own prefix.
DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'
if [ -z "$prefix" ] && [ -z "$legacy" ]; then
  prefix=$DEFAULT_IMAGE_PREFIX
  echo "deploy: YODA_IMAGE_PREFIX is not set: using the public release images, $prefix (pinned in release.env)"
fi

# The signed bundle's image digests (bundle.env, unpacked with the compose files): used for its own release and
# prefix only. A deploy of another version, or from a registry that built its own images, runs the tags: the
# variables are then pinned empty (compose before v2.25 warns about unset ones).
pins='YODA_CORE_DIGEST=
YODA_PORTAL_DIGEST=
YODA_RUNNER_DIGEST=
YODA_BACKUP_DIGEST=
'
if [ -f bundle.env ]; then
  bversion=$(sed -n 's/^YODA_VERSION=\([A-Za-z0-9._-]*\)$/\1/p' bundle.env | tail -n 1)
  bprefix=$(sed -n 's/^YODA_IMAGE_PREFIX=\([A-Za-z0-9._:/-]*\)$/\1/p' bundle.env | tail -n 1)
  if [ "$bversion" = "$YODA_VERSION" ] && grep -q '^YODA_[A-Z]*_DIGEST=' bundle.env; then
    if [ "$bprefix" = "${prefix:-$legacy}" ]; then
      pins=''
      for name in CORE PORTAL RUNNER BACKUP; do
        d=$(sed -n "s/^YODA_${name}_DIGEST=//p" bundle.env | tail -n 1)
        printf '%s\n' "$d" | grep -Eqx 'sha256:[0-9a-f]{64}' || {
          echo "deploy: bundle.env has no valid YODA_${name}_DIGEST" >&2
          exit 2
        }
        pins="${pins}YODA_${name}_DIGEST=$d
"
      done
      echo "deploy: images pinned by digest (bundle.env of $YODA_VERSION)"
    else
      echo "deploy: bundle.env pins the digests of $bprefix, not ${prefix:-$legacy}: running the $YODA_VERSION tags"
    fi
  fi
fi
READY_TIMEOUT="${READY_TIMEOUT:-120}"

if [ ! -e .env ]; then
  (umask 077 && : > .env)
  echo "deploy: created an empty .env (nothing in it is required; see docs/operations.md, section 3)"
fi

# The release under way; it replaces release.env only once its images are on the host.
release=release.env.next
printf 'YODA_VERSION=%s\n' "$YODA_VERSION" > "$release"
[ -z "$prefix" ] || printf 'YODA_IMAGE_PREFIX=%s\n' "$prefix" >> "$release"
printf '%s' "$pins" >> "$release"

dc() {
  docker compose --env-file .env --env-file "$release" -f docker-compose.yml -f docker-compose.prod.yml "$@"
}

echo "deploy: $YODA_VERSION"
pull_failed() {
  echo "deploy: $1 (registry login on this host? the release $YODA_VERSION published? for ghcr.io packages that are not public: docker login ghcr.io with a GitHub token that may read packages)" >&2
  exit 3
}
dc pull --quiet || pull_failed "pulling the images of $YODA_VERSION failed"
# `pull` only warns when an image that could be built is missing; never fall back to building on the host.
for image in $(dc config --images); do
  docker image inspect "$image" >/dev/null 2>&1 || pull_failed "image $image is missing"
done
mv "$release" release.env
release=release.env

dc run --rm init
dc run --rm migrate
dc up -d --no-build --remove-orphans

waited=0
until dc exec -T portal node -e "fetch('http://127.0.0.1:3000/api/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; do
  if [ "$waited" -ge "$READY_TIMEOUT" ]; then
    echo "deploy: not ready after ${READY_TIMEOUT}s; see docs/operations.md, Troubleshooting" >&2
    dc ps >&2
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "deploy: $YODA_VERSION ready"

# Setup state only (public, no secrets); an older core without /public-config prints nothing.
setup=$(dc exec -T core node -e "fetch('http://127.0.0.1:4000/public-config').then((r) => r.json()).then((c) => console.log(c.setup === 'required' ? 'required' : 'done'), () => console.log('unknown'))" 2>/dev/null || true)
if [ "$setup" = required ]; then
  port=$(sed -n 's/^PORTAL_PORT=\([0-9][0-9]*\)$/\1/p' .env | tail -n 1)
  cat <<EOF
deploy: setup is not finished. Open the setup wizard:
  http://127.0.0.1:${port:-3000}/setup   (through your reverse proxy: https://<public host>/setup)
  From another machine: ssh -L ${port:-3000}:127.0.0.1:${port:-3000} <this host>, then open the address above.
Get the setup token (this output never shows it), in $(pwd):
  docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml exec core yoda-admin setup-token
It is also in core's log, in the "Yoda setup" banner (same command with: logs core).
EOF
fi
