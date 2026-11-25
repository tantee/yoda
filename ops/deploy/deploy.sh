#!/bin/sh
# Deploys one release on the deploy host, from the directory holding docker-compose.yml, docker-compose.prod.yml
# and the production .env (YODA_IMAGE_PREFIX and every secret). The GitLab `deploy` job copies this file there
# and runs it; by hand (also to roll back): cd <deploy path> && YODA_VERSION=<tag> sh ops/deploy/deploy.sh
#
# 1. pull the release's images (nothing is built on the host);
# 2. run the database migrations once, in the one-shot `migrate` container; a failed migration stops here,
#    before any running container is replaced;
# 3. start or replace the services;
# 4. wait up to READY_TIMEOUT seconds (120) for the portal's /api/ready (portal -> core: database, storage,
#    job queue); exit 1 otherwise.
set -eu

: "${YODA_VERSION:?YODA_VERSION (the release tag) is required}"
case "$YODA_VERSION" in
  '' | -* | *[!A-Za-z0-9._-]*)
    echo "deploy: invalid YODA_VERSION" >&2
    exit 2
    ;;
esac
export YODA_VERSION
READY_TIMEOUT="${READY_TIMEOUT:-120}"

dc() {
  docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"
}

echo "deploy: $YODA_VERSION"
dc pull --quiet
# `pull` only warns when an image that could be built is missing; never fall back to building on the host.
for image in $(dc config --images); do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "deploy: image $image is missing (registry login on this host? pipeline for $YODA_VERSION finished?)" >&2
    exit 1
  fi
done

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
