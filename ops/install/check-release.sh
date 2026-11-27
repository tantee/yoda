#!/bin/sh
# End-to-end check of a built and signed release directory, the way a host installs it: serves the directory from
# a local HTTP server in the internal-mirror layout (<base>/releases/<version>/), runs the directory's own
# install.sh against it with a stub `docker` (nothing is pulled or started), and checks that it verified the
# signature and the checksum, unpacked the bundle and pinned the release. Then it checks that a signature from
# another key is refused. The release workflow (.github/workflows/release.yml) runs it on every dry run and before
# publishing a release:
#
#   sh ops/install/check-release.sh <version> <release dir> <image prefix>
#
# <release dir> holds install.sh, yoda-<version>.tar.gz, SHA256SUMS and SHA256SUMS.minisig. The signature is
# checked with YODA_RELEASE_PUBKEY when set (a dry run's throwaway key), else with the key embedded in install.sh.
# Needs python3 (the HTTP server), curl or wget, minisign, tar.
set -eu

[ $# -eq 3 ] || { echo 'usage: check-release.sh <version> <release dir> <image prefix>' >&2; exit 2; }
version=$1
rel=$2
prefix=$3
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
[ "$(cat "$work/srv/yoda/release.env")" = "$want" ] || fail "release.env is not: $want"
for f in docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh .env.example bundle.env; do
  [ -f "$work/srv/yoda/$f" ] || fail "the bundle has no $f"
done
grep -qx "YODA_IMAGE_PREFIX=$prefix" "$work/srv/yoda/bundle.env" || fail "bundle.env does not name $prefix"
grep -q '^compose .* run --rm migrate$' "$work/docker.log" || fail 'deploy.sh did not run'
case "$prefix" in
  ghcr.io/*) ! grep -q '^login' "$work/docker.log" || fail 'install.sh logged in to ghcr.io (its images are public)' ;;
esac

# A signature from any other key must be refused.
minisign -G -W -p "$work/other.pub" -s "$work/other.key" > /dev/null
other=$(sed -n 2p "$work/other.pub")
if YODA_RELEASE_PUBKEY=$other install --dir "$work/srv/other" > "$work/other.log" 2>&1; then
  fail 'install.sh accepted a signature check with another key'
fi
grep -qF 'signature check FAILED' "$work/other.log" || { cat "$work/other.log" >&2; fail 'install.sh failed for another reason than the signature'; }
[ ! -e "$work/srv/other/docker-compose.yml" ] || fail 'install.sh unpacked a release it refused'

echo "check-release: $version verified end to end (signature, checksum, unpack, release.env, deploy)"
