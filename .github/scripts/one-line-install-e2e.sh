#!/bin/sh
# The README's one-line install on a fresh Ubuntu, end to end, against a dry run's signed release directory
# (.github/workflows/release.yml, job one-line-install; dry runs only):
#
#   sh .github/scripts/one-line-install-e2e.sh <version> <release dir> <image prefix>
#
# with UBUNTU_IMAGE (ubuntu:24.04, pinned by digest) and YODA_RELEASE_PUBKEY (the dry run's throwaway public key).
# The release directory (install.sh, yoda-<version>.tar.gz, SHA256SUMS, SHA256SUMS.minisig) is served from a local
# HTTP server on the runner, laid out like GitHub's: releases/<version>/<file>, releases/latest/download/install.sh,
# and releases/latest redirecting to releases/tag/v<version>. A privileged container of that image, on the host
# network, starts as an Ubuntu server does: curl, ca-certificates and sudo, and a user `deploy` with sudo. As
# `deploy`, never as root, it runs exactly the one-liner with --yes:
#
#   curl -fsSL <server>/releases/latest/download/install.sh | sh -s -- --yes --base-url '<server>/releases/{version}/'
#
# (--base-url and YODA_LATEST_URL point it at the local server instead of GitHub; YODA_RELEASE_PUBKEY at the
# throwaway key; the published install.sh names its release, RELEASE_VERSION, so nothing is looked up.) Run 1, on the bare host: it must report minisign, Docker Engine and the Compose plugin missing,
# install minisign from Ubuntu's archive and docker-ce plus the Compose plugin (v2.24 or later) from Docker's apt
# repository, add `deploy` to the docker group, and stop at the daemon: a container has no systemd to start it.
# Then dockerd is started by hand inside the container, and run 2 (the same one-liner) must get everything else
# right: nothing missing, the release install.sh names, SHA256SUMS and its signature
# downloaded and verified (the trusted comment exactly this release), the bundle's checksum, /srv/yoda created
# with sudo and given to `deploy`, the bundle unpacked, .env (0600) and release.env written, and deploy.sh started.
# That is where a dry run ends: its images were never pushed, so deploy.sh's pull fails (exit 3) and install.sh
# stops with "deploy of <version> failed". The check asserts the run got exactly to that boundary and no further
# (release.env still holds only install.sh's image prefix: deploy.sh pins nothing before its pull succeeded).
# Needs docker and python3 on the runner.
set -eu

[ $# -eq 3 ] || { echo 'usage: one-line-install-e2e.sh <version> <release dir> <image prefix>' >&2; exit 2; }
version=$1
rel=$2
prefix=$3
image=${UBUNTU_IMAGE:?UBUNTU_IMAGE (ubuntu:24.04@sha256:...) is required}
: "${YODA_RELEASE_PUBKEY:?YODA_RELEASE_PUBKEY (the dry run public key) is required}"
export YODA_RELEASE_PUBKEY
for f in install.sh "yoda-$version.tar.gz" SHA256SUMS SHA256SUMS.minisig; do
  [ -f "$rel/$f" ] || { echo "one-line-install: $rel/$f is missing" >&2; exit 1; }
done

work=$(mktemp -d)
name="yoda-one-line-$$"
pid=''
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() {
  echo "one-line-install: FAILED: $*" >&2
  exit 1
}
say() { printf '\n=== %s\n' "$*"; }
# expect LOG LINE...: every line is in the log, as a fixed string.
expect() {
  log=$1
  shift
  for line; do
    grep -qF -- "$line" "$log" || fail "$(basename "$log") does not say: $line"
    echo "ok: $line"
  done
}

# --- the release server ---------------------------------------------------------------------------------------
mkdir -p "$work/www/releases/$version" "$work/www/releases/latest/download"
cp "$rel/install.sh" "$rel/yoda-$version.tar.gz" "$rel/SHA256SUMS" "$rel/SHA256SUMS.minisig" "$work/www/releases/$version/"
cp "$rel/install.sh" "$work/www/releases/latest/download/install.sh"
python3 -c '
import functools, http.server, os, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    # GitHub answers releases/latest with a redirect to releases/tag/v<version>.
    def latest(self):
        if self.path != "/releases/latest":
            return False
        self.send_response(302)
        self.send_header("Location", "/releases/tag/v" + sys.argv[3])
        self.end_headers()
        return True
    def do_HEAD(self):
        self.latest() or super().do_HEAD()
    def do_GET(self):
        self.latest() or super().do_GET()
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=sys.argv[1]))
with open(sys.argv[2] + ".tmp", "w") as f:
    f.write(str(server.server_address[1]))
os.rename(sys.argv[2] + ".tmp", sys.argv[2])
server.serve_forever()
' "$work/www" "$work/port" "$version" 2> "$work/http.log" &
pid=$!
i=0
until [ -s "$work/port" ]; do
  i=$((i + 1))
  [ "$i" -le 50 ] || { cat "$work/http.log" >&2; fail 'the HTTP server did not start'; }
  sleep 0.2
done
origin="http://localhost:$(cat "$work/port")"

# --- a fresh Ubuntu server ------------------------------------------------------------------------------------
say "a fresh $image: curl, ca-certificates and sudo only, and the user deploy with sudo"
# Privileged for the dockerd started below; /var/lib/docker on a volume, so it may use overlay2.
docker run -d --privileged --network host -v /var/lib/docker --name "$name" "$image" sleep infinity > /dev/null
docker exec "$name" sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates sudo > /dev/null' ||
  fail 'cannot prepare the container (apt-get install curl ca-certificates sudo)'
docker exec "$name" sh -c 'useradd -m -s /bin/bash deploy && echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy'
docker exec "$name" sh -c '. /etc/os-release; echo "$PRETTY_NAME"; for t in curl sudo tar sha256sum minisign docker openssl; do printf "  %-10s %s\n" "$t" "$(command -v "$t" || echo missing)"; done'
docker exec "$name" sh -c '! command -v minisign && ! command -v docker' > /dev/null || fail 'the image already has minisign or docker'

oneliner="curl -fsSL $origin/releases/latest/download/install.sh | sh -s -- --yes --base-url '$origin/releases/{version}/'"
# As deploy, with no terminal (docker exec without -t): every question is answered by --yes, none assumed.
as_deploy() {
  docker exec -u deploy -w /home/deploy -e YODA_RELEASE_PUBKEY -e YODA_LATEST_URL="$origin/releases/latest" "$name" sh -c "$1"
}

# --- run 1: the dependencies ------------------------------------------------------------------------------------
say "run 1, as deploy: $oneliner"
rc=0
as_deploy "$oneliner" > "$work/run1.log" 2>&1 || rc=$?
# The apt and dpkg noise is long; the installer's own lines are what matters.
grep -E '^(install:|  - |  sudo |  Docker|deploy:)' "$work/run1.log" || true
echo "(run 1 exit $rc; $(wc -l < "$work/run1.log") lines with apt's output)"
[ "$rc" -ne 0 ] || fail 'run 1 succeeded: without a Docker daemon it must stop at the daemon check'
expect "$work/run1.log" \
  'install: missing or too old:' \
  '  - minisign: not found (checks the release signature)' \
  '  - Docker Engine: not found, needs 24 or later' \
  '  - Docker Compose plugin: not found, needs v2.24 or later' \
  'install: install.sh can install them now (sudo), with:' \
  'install:   sudo apt-get install -y ca-certificates curl minisign' \
  "install:   Docker's apt repository (https://download.docker.com/linux/ubuntu, release noble): download its GPG key" \
  'install:     write /etc/apt/sources.list.d/docker.list, sudo apt-get update, sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' \
  'install:   sudo usermod -aG docker deploy   (the docker group is root-equivalent' \
  'install: Install them now? yes (--yes)' \
  'install: cannot talk to the Docker daemon'
grep -qE "^install: (Docker's repository key: fingerprint 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \(checked with gpg\)|warning: gpg is not here, so the Docker repository key's fingerprint is not checked)" "$work/run1.log" ||
  fail "run 1 did not check Docker's repository key"
! grep -qF 'curl: not found' "$work/run1.log" || fail 'run 1 reported curl missing (the image has it)'
! grep -qF 'install: downloading' "$work/run1.log" || fail 'run 1 downloaded the release before its dependencies were there'

say 'what run 1 installed'
docker exec "$name" sh -c '
  cat /etc/apt/sources.list.d/docker.list
  ls -l /etc/apt/keyrings/docker.asc
  dpkg-query -W -f "\${Package} \${Version}\n" minisign docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  apt-cache policy minisign docker-ce docker-compose-plugin | grep -E "^[a-z]|\*\*\*" -A1
  id -nG deploy' | tee "$work/installed.txt"
grep -q '^deb \[arch=[a-z0-9]* signed-by=/etc/apt/keyrings/docker.asc\] https://download.docker.com/linux/ubuntu noble stable$' "$work/installed.txt" ||
  fail "Docker's apt repository is not in /etc/apt/sources.list.d/docker.list"
for p in minisign docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
  grep -q "^$p " "$work/installed.txt" || fail "$p is not installed"
done
docker exec "$name" sh -c 'apt-cache policy docker-ce | grep -A1 "^ \*\*\*" | grep -q download.docker.com' || fail 'docker-ce is not from download.docker.com'
docker exec "$name" sh -c 'apt-cache policy minisign | grep -A1 "^ \*\*\*" | grep -q "archive.ubuntu.com\|ports.ubuntu.com"' || fail 'minisign is not from the Ubuntu archive'
grep -qw docker "$work/installed.txt" || fail 'deploy was not added to the docker group'
compose=$(docker exec "$name" docker compose version --short)
cmaj=${compose%%.*}
crest=${compose#*.}
cmin=${crest%%.*}
{ [ "$cmaj" -gt 2 ] || { [ "$cmaj" -eq 2 ] && [ "$cmin" -ge 24 ]; }; } || fail "Docker Compose $compose is older than 2.24"
echo "ok: Docker Compose $compose (2.24 or later), $(docker exec "$name" docker --version)"

# --- the daemon: no systemd in a container, so by hand ----------------------------------------------------------
say 'start dockerd inside the container (no systemd)'
docker exec -d "$name" sh -c 'dockerd > /tmp/dockerd.log 2>&1'
i=0
until docker exec "$name" docker info > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 60 ] || { docker exec "$name" tail -n 30 /tmp/dockerd.log >&2 || true; fail 'dockerd did not start'; }
  sleep 1
done
docker exec "$name" docker version --format 'ok: Docker Engine {{.Server.Version}} is running'

# --- run 2: the release ----------------------------------------------------------------------------------------
say "run 2, as deploy: $oneliner"
rc=0
as_deploy "$oneliner" > "$work/run2.log" 2>&1 || rc=$?
cat "$work/run2.log"
echo "(run 2 exit $rc)"
[ "$rc" -ne 0 ] || fail 'run 2 succeeded, but the images of a dry run were never pushed: what did it deploy?'
expect "$work/run2.log" \
  "install: release $version (the one this install.sh belongs to; --version picks another)" \
  "install: downloading Yoda $version from $origin/releases/$version/" \
  'install: signature and checksum verified' \
  'install: cannot create /srv/yoda as deploy (no write access to /srv)' \
  'install: Create /srv/yoda with sudo and give it to deploy? yes (--yes)' \
  'install: created /srv/yoda for deploy' \
  "install: images: $prefix/<core|portal|runner|backup>:$version, pinned by the digests in the signed bundle.env" \
  "install: deploying $version in /srv/yoda" \
  "deploy: images pinned by digest (bundle.env of $version)" \
  "deploy: pulling the images of $version failed" \
  "install: deploy of $version failed (images $prefix/<name>:$version"
! grep -qF 'missing or too old' "$work/run2.log" || fail 'run 2 still found something missing'
! grep -qF 'finding the latest release' "$work/run2.log" || fail 'run 2 looked up the latest release although install.sh names its own'
# Nothing past the pull ran.
! grep -qF 'run --rm init' "$work/run2.log" || fail 'deploy.sh went past the failed pull'

say 'what run 2 left in /srv/yoda'
docker exec "$name" sh -c '
  stat -c "%U:%G %a %n" /srv/yoda /srv/yoda/.env /srv/yoda/release.env
  ls /srv/yoda
  echo "--- release.env"; cat /srv/yoda/release.env
  echo "--- bundle.env"; cat /srv/yoda/bundle.env' | tee "$work/srv.txt"
grep -q '^deploy:deploy [0-7]* /srv/yoda$' "$work/srv.txt" || fail '/srv/yoda is not owned by deploy'
grep -q '^deploy:deploy 600 /srv/yoda/.env$' "$work/srv.txt" || fail '/srv/yoda/.env is not 0600 and deploy'"'"'s'
for f in docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh ops/proxy/Caddyfile bundle.env; do
  docker exec "$name" test -f "/srv/yoda/$f" || fail "the bundle's $f was not unpacked"
done
# install.sh pinned the prefix; deploy.sh pins the release only after its pull, which a dry run never passes.
[ "$(docker exec "$name" cat /srv/yoda/release.env)" = "YODA_IMAGE_PREFIX=$prefix" ] || fail "release.env is not just YODA_IMAGE_PREFIX=$prefix"
grep -qx "YODA_VERSION=$version" "$work/srv.txt" || fail "bundle.env is not release $version"
[ "$(grep -c '^YODA_[A-Z]*_DIGEST=sha256:[0-9a-f]\{64\}$' "$work/srv.txt")" -eq 4 ] || fail 'bundle.env does not pin the four image digests'

say 'requests the release server answered'
sed -n 's/.*"\(GET\|HEAD\) \([^ ]*\) HTTP[^"]*" \([0-9]*\).*/\1 \2 \3/p' "$work/http.log" | sort | uniq -c
echo
echo "one-line-install: the one-liner installed its dependencies (minisign from apt, Docker from Docker's repository, compose $compose), verified release $version and unpacked it into /srv/yoda; it stopped at the image pull, as a dry run must"
