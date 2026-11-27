#!/bin/sh
# End-to-end check of a built and signed release directory, the way a host installs it. It serves the directory
# from a local HTTP server and runs the directory's own install.sh against it with --base-url
# http://127.0.0.1:<port>/releases/{version}/, with a stub `docker` first on PATH (nothing is pulled or started).
# It checks that install.sh verified the signature and the checksum, unpacked the bundle and pinned the release
# in release.env: the version, the image prefix and, given a digests file, exactly those image digests (also when
# installed with a mirror's prefix: digests name content, not a registry). With a
# real `docker compose` on the machine it also resolves the prod compose files with that release.env and checks
# every image is <prefix>/<name>:<version>@<digest>. Then it checks that a signature from another key is refused.
# The release workflow (.github/workflows/release.yml) runs it on every dry run and on a real release, before the
# bundle is kept for the release and before any image is tagged:
#
#   sh ops/install/check-release.sh <version> <release dir> <image prefix> [<digests file>]
#
# <release dir> holds install.sh, yoda-<version>.tar.gz, SHA256SUMS and SHA256SUMS.minisig. The digests file is
# bundle.sh's ("<name> sha256:<hex>" per image). The signature is checked with YODA_RELEASE_PUBKEY when set (a dry
# run's throwaway key), else with the key embedded in install.sh.
# Needs python3 (the HTTP server), curl or wget, minisign, tar.
set -eu

[ $# -eq 3 ] || [ $# -eq 4 ] || { echo 'usage: check-release.sh <version> <release dir> <image prefix> [<digests file>]' >&2; exit 2; }
version=$1
rel=$2
prefix=$3
digests=${4:-}
[ -z "$digests" ] || [ -f "$digests" ] || { echo "check-release: $digests is missing" >&2; exit 1; }
# The machine's own docker, if any, for the compose check (the install below runs with a stub first on PATH).
real_docker=$(command -v docker || true)
for f in install.sh "yoda-$version.tar.gz" SHA256SUMS SHA256SUMS.minisig; do
  [ -f "$rel/$f" ] || { echo "check-release: $rel/$f is missing" >&2; exit 1; }
done

work=$(mktemp -d)
pid=''
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$work/www/releases/$version" "$work/bin"
cp "$rel/install.sh" "$rel/yoda-$version.tar.gz" "$rel/SHA256SUMS" "$rel/SHA256SUMS.minisig" "$work/www/releases/$version/"

# A stub docker: the versions install.sh checks, and success for every compose call deploy.sh makes.
cat > "$work/bin/docker" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_DOCKER_LOG"
case "$1" in
  version) echo 27.5.1 ;;
  compose)
    case " $* " in
      *" version --short "*) echo 2.29.1 ;;
      *" exec -T core "*) echo done ;;
    esac
    ;;
esac
exit 0
STUB
chmod 755 "$work/bin/docker"

python3 -c '
import functools, http.server, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
with open(sys.argv[2] + ".tmp", "w") as f:
    f.write(str(server.server_address[1]))
__import__("os").rename(sys.argv[2] + ".tmp", sys.argv[2])
server.serve_forever()
' "$work/www" "$work/port" 2> "$work/http.log" &
pid=$!
i=0
until [ -s "$work/port" ]; do
  i=$((i + 1))
  [ "$i" -le 50 ] || { cat "$work/http.log" >&2; echo 'check-release: the HTTP server did not start' >&2; exit 1; }
  sleep 0.2
done
base="http://127.0.0.1:$(cat "$work/port")/releases/{version}/"

# install.sh in a clean environment: the stub docker first on PATH, a fresh HOME (no saved registry logins).
install() {
  env -i PATH="$work/bin:$PATH" HOME="$work/home" STUB_DOCKER_LOG="$work/docker.log" \
    ${YODA_RELEASE_PUBKEY:+YODA_RELEASE_PUBKEY="$YODA_RELEASE_PUBKEY"} \
    sh "$work/www/releases/$version/install.sh" --version "$version" --base-url "$base" "$@"
}
mkdir -p "$work/home"
: > "$work/docker.log"

echo "check-release: installing $version from $base"
install --dir "$work/srv/yoda" > "$work/install.log" 2>&1 || {
  cat "$work/install.log" >&2
  echo 'check-release: FAILED: install.sh refused the release' >&2
  exit 1
}
cat "$work/install.log"
fail() {
  echo "check-release: FAILED: $*" >&2
  exit 1
}
grep -qF 'signature and checksum verified' "$work/install.log" || fail 'install.sh did not verify the release'
want=$(printf 'YODA_VERSION=%s\nYODA_IMAGE_PREFIX=%s' "$version" "$prefix")
if [ -n "$digests" ]; then
  for name in core portal runner backup; do
    d=$(awk -v n="$name" '$1 == n { print $2 }' "$digests")
    upper=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
    grep -qx "YODA_${upper}_DIGEST=$d" "$work/srv/yoda/bundle.env" || fail "bundle.env does not pin $name at $d"
    want=$(printf '%s\nYODA_%s_DIGEST=%s' "$want" "$upper" "$d")
  done
elif grep -q '_DIGEST=' "$work/srv/yoda/bundle.env"; then
  fail 'bundle.env pins digests that were not given to check'
else
  want=$(printf '%s\nYODA_CORE_DIGEST=\nYODA_PORTAL_DIGEST=\nYODA_RUNNER_DIGEST=\nYODA_BACKUP_DIGEST=' "$want")
fi
[ "$(cat "$work/srv/yoda/release.env")" = "$want" ] || fail "release.env is not: $want"
for f in docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh .env.example bundle.env; do
  [ -f "$work/srv/yoda/$f" ] || fail "the bundle has no $f"
done
grep -qx "YODA_IMAGE_PREFIX=$prefix" "$work/srv/yoda/bundle.env" || fail "bundle.env does not name $prefix"
grep -q '^compose .* run --rm migrate$' "$work/docker.log" || fail 'deploy.sh did not run'
case "$prefix" in
  ghcr.io/*) ! grep -q '^login' "$work/docker.log" || fail 'install.sh logged in to ghcr.io (its images are public)' ;;
esac

# The compose files resolve to the pinned images (a real docker compose only; the stub cannot interpolate).
if [ -n "$real_docker" ] && "$real_docker" compose version > /dev/null 2>&1; then
  images=$(cd "$work/srv/yoda" && env -u YODA_VERSION -u YODA_IMAGE_PREFIX "$real_docker" compose --env-file .env --env-file release.env \
    -f docker-compose.yml -f docker-compose.prod.yml --profile runner config --images 2>&1) ||
    { printf '%s\n' "$images" >&2; fail 'docker compose config failed with this release.env'; }
  for name in core portal runner backup; do
    ref="$prefix/$name:$version"
    if [ -n "$digests" ]; then ref="$ref@$(awk -v n="$name" '$1 == n { print $2 }' "$digests")"; fi
    printf '%s\n' "$images" | grep -qxF "$ref" || { printf '%s\n' "$images" >&2; fail "the compose files do not run $ref"; }
  done
  echo "check-release: compose runs the pinned images"
else
  echo 'check-release: no docker compose here: skipped the compose image check'
fi

# Digests name content, not a registry: installed with a mirror's prefix, the same digests stay pinned.
if [ -n "$digests" ]; then
  install --dir "$work/srv/mirror" --image-prefix registry.example.org/mirror/yoda > "$work/mirror.log" 2>&1 ||
    { cat "$work/mirror.log" >&2; fail 'install.sh refused the release with a mirror prefix'; }
  for name in CORE PORTAL RUNNER BACKUP; do
    grep -qx "YODA_${name}_DIGEST=sha256:[0-9a-f]\{64\}" "$work/srv/mirror/release.env" ||
      fail "with a mirror prefix, release.env does not pin YODA_${name}_DIGEST"
  done
fi

# A signature from any other key must be refused.
minisign -G -W -p "$work/other.pub" -s "$work/other.key" > /dev/null
other=$(sed -n 2p "$work/other.pub")
if YODA_RELEASE_PUBKEY=$other install --dir "$work/srv/other" > "$work/other.log" 2>&1; then
  fail 'install.sh accepted a signature check with another key'
fi
grep -qF 'signature check FAILED' "$work/other.log" || { cat "$work/other.log" >&2; fail 'install.sh failed for another reason than the signature'; }
[ ! -e "$work/srv/other/docker-compose.yml" ] || fail 'install.sh unpacked a release it refused'

echo "check-release: $version verified end to end (signature, checksum, unpack, release.env, deploy)"
