#!/bin/sh
# Installs one pinned Yoda release on a fresh host (docs/operations.md, section 4; installer proposal §3.4).
#
#   sh install.sh --version 1.2.0 [--dir /srv/yoda] [--base-url URL] [--image-prefix PREFIX] [--no-login]
#
# 1. preflight: Docker Engine 24+, Compose v2.24+, the user can run docker, curl or wget, sha256sum or shasum,
#    minisign, tar; warns below 10 GB free;
# 2. downloads <base>{SHA256SUMS,SHA256SUMS.minisig,yoda-<version>.tar.gz} into a temp dir, where <base> is the
#    release's directory: by default the GitHub Release assets, https://github.com/tantee/yoda/releases/download/v<version>/;
#    an internal mirror passes --base-url (a "{version}" in it becomes the version, e.g.
#    https://files.example.org/yoda/releases/{version}/). It verifies the minisign signature of SHA256SUMS with the release public key below (and that it was signed for
#    this version), then the bundle's SHA-256 against it; refuses on any mismatch, and never runs anything it
#    downloaded before that;
# 3. unpacks the bundle into --dir (default /srv/yoda), refusing an existing install (upgrade with deploy.sh),
#    and creates an empty .env (0600): nothing has to go in it;
# 4. `docker login <registry>` when the images' registry is not ghcr.io (public images) and has no saved login
#    (interactive: the token is typed, never an argument);
# 5. pins the image prefix in release.env (never Docker Hub), then runs ops/deploy/deploy.sh (pull, pin release.env, init, migrate, up, wait for /api/ready), which prints the
#    setup wizard's address and the setup-token command while setup is not finished.
#
# Env (the options win): YODA_VERSION, YODA_DIR, YODA_RELEASE_BASE_URL, YODA_IMAGE_PREFIX, and
# YODA_RELEASE_PUBKEY (a minisign public key replacing the embedded one; tests and key rotation only).
# POSIX sh, no sudo inside: run it as a user who may run docker and write --dir.
set -eu

# The release signing public key (minisign key id C73EF0AF404BAE84, the second line of keys/yoda-release.pub;
# docs/releasing.md, "Verifying releases"). A fork or mirror with its own key replaces it; a placeholder containing
# REPLACE-WITH is refused below.
RELEASE_PUBKEY_EMBEDDED='RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j'
# Where releases are published (D1): GitHub Release assets and GHCR images. "{version}" becomes the version.
# An internal mirror overrides both: --base-url / YODA_RELEASE_BASE_URL and --image-prefix / YODA_IMAGE_PREFIX.
DEFAULT_BASE_URL='https://github.com/tantee/yoda/releases/download/v{version}/'
DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'
MIN_COMPOSE='2.24'
MIN_ENGINE=24
MIN_FREE_KB=10485760

say() { printf 'install: %s\n' "$*"; }
die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}
usage() {
  sed -n '3,4p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

version="${YODA_VERSION:-}"
dir="${YODA_DIR:-/srv/yoda}"
base="${YODA_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}"
prefix="${YODA_IMAGE_PREFIX:-}"
login=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || usage 2; version=$2; shift 2 ;;
    --version=*) version=${1#*=}; shift ;;
    --dir) [ $# -ge 2 ] || usage 2; dir=$2; shift 2 ;;
    --dir=*) dir=${1#*=}; shift ;;
    --base-url) [ $# -ge 2 ] || usage 2; base=$2; shift 2 ;;
    --base-url=*) base=${1#*=}; shift ;;
    --image-prefix) [ $# -ge 2 ] || usage 2; prefix=$2; shift 2 ;;
    --image-prefix=*) prefix=${1#*=}; shift ;;
    --no-login) login=no; shift ;;
    -h | --help) usage 0 ;;
    *) printf 'install: unknown option %s\n' "$1" >&2; usage 2 ;;
  esac
done

# --- arguments ------------------------------------------------------------------------------------------------
[ -n "$version" ] || die 'a pinned release is required: --version <x.y.z> (see CHANGELOG.md); "latest" is refused'
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
  die "not a pinned release version: $version (expected x.y.z)"
case "$dir" in
  /*) ;;
  *) die "--dir must be an absolute path: $dir" ;;
esac
case "$dir" in
  *[!A-Za-z0-9._/-]*) die "--dir may hold only A-Z a-z 0-9 . _ - /: $dir" ;;
esac
case "$base" in
  https://*) ;;
  http://*) say "warning: $base is not https; the signature check still protects the bundle" ;;
  *) die "--base-url must be an http(s) URL: $base" ;;
esac
# The version is checked above (A-Z a-z 0-9 . -): safe in a sed replacement.
base=$(printf '%s\n' "$base" | sed "s/{version}/$version/g")
case "$base" in
  */) ;;
  *) base="$base/" ;;
esac
if [ -n "$prefix" ]; then
  case "$prefix" in
    -* | *[!A-Za-z0-9._:/-]*) die "invalid image prefix: $prefix" ;;
  esac
fi
pubkey="${YODA_RELEASE_PUBKEY:-$RELEASE_PUBKEY_EMBEDDED}"
case "$pubkey" in
  *REPLACE-WITH*) die 'this install.sh has no release public key yet (placeholder); get the published install.sh, or set YODA_RELEASE_PUBKEY to the key the release owner gave you' ;;
  *[!A-Za-z0-9+/=]*) die 'the release public key is not a minisign key' ;;
esac

# --- preflight ------------------------------------------------------------------------------------------------
missing=''
need() { command -v "$1" >/dev/null 2>&1 || missing="$missing $1"; }
need docker
need tar
need minisign
if command -v curl >/dev/null 2>&1; then fetcher=curl
elif command -v wget >/dev/null 2>&1; then fetcher=wget
else missing="$missing curl-or-wget"; fi
if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
elif command -v shasum >/dev/null 2>&1; then hasher=shasum
else missing="$missing sha256sum"; fi
if [ -n "$missing" ]; then
  die "missing:$missing (minisign: apt install minisign, dnf install minisign, or https://jedisct1.github.io/minisign/)"
fi

engine=$(docker version --format '{{.Server.Version}}' 2>/dev/null) ||
  die 'cannot talk to the Docker daemon: is it running, and may this user run docker (the docker group)?'
case "${engine%%.*}" in
  '' | *[!0-9]*) die "cannot read the Docker Engine version ($engine)" ;;
esac
[ "${engine%%.*}" -ge "$MIN_ENGINE" ] || die "Docker Engine $MIN_ENGINE or later is required (found $engine)"

compose=$(docker compose version --short 2>/dev/null) || die "the Docker Compose plugin v$MIN_COMPOSE or later is required (docker compose version failed)"
compose=${compose#v}
cmaj=${compose%%.*}
crest=${compose#*.}
cmin=${crest%%.*}
case "$cmaj.$cmin" in
  *[!0-9.]* | .* | *.) die "cannot read the Compose version ($compose)" ;;
esac
if [ "$cmaj" -lt 2 ] || { [ "$cmaj" -eq 2 ] && [ "$cmin" -lt 24 ]; }; then
  die "Docker Compose v$MIN_COMPOSE or later is required (found $compose)"
fi

probe=$dir
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
free=$(df -Pk "$probe" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$free" in
  '' | *[!0-9]*) say "warning: cannot read the free disk space at $probe" ;;
  *) [ "$free" -ge "$MIN_FREE_KB" ] || say "warning: less than 10 GB free at $probe (database, files and 14 days of backups need room)" ;;
esac

for f in docker-compose.yml docker-compose.prod.yml release.env ops; do
  [ ! -e "$dir/$f" ] || die "$dir already holds an install ($f); upgrade it with: cd $dir && YODA_VERSION=$version sh ops/deploy/deploy.sh"
done

# --- download and verify --------------------------------------------------------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch() {
  if [ "$fetcher" = curl ]; then
    curl -fsSL --retry 2 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi || die "download failed: $1"
}

bundle="yoda-$version.tar.gz"
say "downloading Yoda $version from $base"
fetch "${base}SHA256SUMS" "$tmp/SHA256SUMS"
fetch "${base}SHA256SUMS.minisig" "$tmp/SHA256SUMS.minisig"
fetch "${base}$bundle" "$tmp/$bundle"

# The signature covers SHA256SUMS and its trusted comment, which names the release: an older signed file served
# for this version is refused too.
out=$(minisign -V -P "$pubkey" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig" 2>&1) ||
  die 'signature check FAILED for SHA256SUMS: refusing to install (wrong key, or the files were changed)'
printf '%s\n' "$out" | grep -qFx "Trusted comment: yoda release $version" ||
  die "signature check FAILED: SHA256SUMS was not signed for release $version"

want=$(awk -v f="$bundle" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS does not list $bundle"
if [ "$hasher" = sha256sum ]; then
  got=$(sha256sum "$tmp/$bundle" | awk '{ print $1 }')
else
  got=$(shasum -a 256 "$tmp/$bundle" | awk '{ print $1 }')
fi
[ "$got" = "$want" ] || die "checksum MISMATCH for $bundle: refusing to install"
say 'signature and checksum verified'

# Paths stay inside the deploy directory: no absolute paths, no `..`, regular files and directories only.
tar -tzf "$tmp/$bundle" > "$tmp/list" || die "cannot read $bundle"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$tmp/list"; then die "$bundle holds an unsafe path"; fi
if tar -tvzf "$tmp/$bundle" | grep -Eqv '^[-d]'; then die "$bundle holds a link or a special file"; fi
for f in docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh; do
  grep -qx "\(\./\)\{0,1\}$f" "$tmp/list" || die "$bundle has no $f"
done

# --- unpack ---------------------------------------------------------------------------------------------------
mkdir -p "$dir" || die "cannot create $dir (create it as root and give it to this user)"
# The files belong to this user, with its umask: never the build machine's owners or modes.
tar -xzf "$tmp/$bundle" -C "$dir" --no-same-owner --no-same-permissions || die "cannot unpack into $dir"
if [ ! -e "$dir/.env" ]; then
  (umask 077 && : > "$dir/.env")
fi
chmod 600 "$dir/.env"

# The image prefix: the option or env, else the bundle's (the registry the release was pushed to), else GHCR.
if [ -z "$prefix" ] && [ -f "$dir/bundle.env" ]; then
  prefix=$(sed -n 's/^YODA_IMAGE_PREFIX=\([A-Za-z0-9._:/-]*\)$/\1/p' "$dir/bundle.env" | tail -n 1)
fi
[ -n "$prefix" ] || prefix=$DEFAULT_IMAGE_PREFIX
# Pinned before the first deploy, so no compose command on this host can fall back to Docker Hub. release.env wins
# over .env; deploy.sh keeps the prefix there on every later deploy.
printf 'YODA_IMAGE_PREFIX=%s\n' "$prefix" > "$dir/release.env"
say "images: $prefix/<core|portal|runner|backup>:$version"

# --- registry login -------------------------------------------------------------------------------------------
# The GHCR images are public: no login. A mirror's registry usually needs one.
registry=${prefix%%/*}
case "$registry" in
  ghcr.io) registry='' ;;
  *.* | *:* | localhost) ;;
  *) registry='' ;;
esac
if [ -n "$registry" ] && [ "$login" = yes ]; then
  config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  if [ -f "$config" ] && grep -qF "\"$registry\"" "$config"; then
    :
  elif [ -t 0 ]; then
    say "log in to $registry with a read_registry deploy token (typed, not shown):"
    docker login "$registry" || die "docker login $registry failed"
  else
    say "warning: no saved login for $registry; if the pull fails, run: docker login $registry"
  fi
fi

# --- deploy ---------------------------------------------------------------------------------------------------
say "deploying $version in $dir"
cd "$dir"
YODA_VERSION="$version" YODA_IMAGE_PREFIX="$prefix" sh ops/deploy/deploy.sh ||
  die "deploy of $version failed (images $prefix/<name>:$version; registry login: docker login ${prefix%%/*}? see docs/operations.md, Troubleshooting). Fix it, then: cd $dir && YODA_VERSION=$version sh ops/deploy/deploy.sh"

cat <<EOF
install: Yoda $version is running in $dir.
  Commands there (docs/operations.md, section 4):
    alias dc='docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'
  Upgrade later: cd $dir && YODA_VERSION=<version> sh ops/deploy/deploy.sh (or an internal mirror's deploy job)
  Finish the setup wizard, and store the recovery kit it gives you off this host.
EOF
