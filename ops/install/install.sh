#!/bin/sh
# Installs one Yoda release on a fresh host (docs/operations.md, section 4; installer proposal §3.4). One line:
#
#   curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh -s -- --version 1.2.0 \
#     --dir /srv/yoda --with-proxy --domain portal.example.org
#
# or, after checking install.sh itself: sh install.sh [options] (usage() below lists them).
#
# 0. the whole script is functions; the last line calls main, so a download cut short runs nothing at all;
# 1. dependencies first: curl, tar, sha256sum or shasum, minisign, Docker Engine 24+ with Compose v2.24+, and
#    openssl for --cert-mode files. It prints what is missing (found vs needed). On Debian and Ubuntu (apt; minisign
#    from universe on Ubuntu, Docker from Docker's own apt repository) and the RHEL family (dnf; minisign from EPEL,
#    Docker from Docker's repository) it offers to install them with sudo (root needs none), asking on the
#    terminal (/dev/tty, so it works when piped) or with --yes; never silently, and with no terminal and no --yes
#    it stops and names the flag. Docker from the distribution (docker.io, docker-compose-v2) that is too old is
#    explained, never replaced. A user who may not run docker is added to the docker group (asked the same way);
#    this run then uses the group through `sg docker` (a `docker` wrapper first on PATH, for deploy.sh too), new
#    logins get it by themselves. Any other system: the manual steps, and exit 1;
# 2. the release: --version, else the one a signed SHA256SUMS next to install.sh names (sh install.sh in the
#    directory of the downloaded assets), else the latest GitHub release (the releases/latest redirect, then the
#    GitHub API; no jq). An internal mirror (--base-url) has no "latest": it needs --version;
# 3. downloads <base>{SHA256SUMS,SHA256SUMS.minisig} (unless they are next to install.sh; always when piped), where
#    <base> is the release's directory: by default the GitHub Release assets,
#    https://github.com/tantee/yoda/releases/download/v<version>/; an internal mirror passes --base-url (a
#    "{version}" in it becomes the version, e.g. https://files.example.org/yoda/releases/{version}/). It checks
#    the minisign signature with the release public key below and that its trusted comment is exactly
#    "yoda release <version>", then downloads yoda-<version>.tar.gz (or takes it from next to install.sh) and
#    checks its SHA-256 against the signed list. Any failure stops it: nothing it downloaded runs before that, and
#    nothing is unpacked. Next to SHA256SUMS, install.sh must match its own signed checksum too;
# 4. unpacks the bundle into --dir (default /srv/yoda; when it cannot be created, it offers to create it with sudo
#    and give it to this user, asked as above), refusing an existing install (upgrade with deploy.sh), and creates
#    an empty .env (0600): nothing has to go in it. It warns below 10 GB free, naming the free space and the path;
# 5. `docker login <registry>` when the images' registry is not ghcr.io (public images) and has no saved login
#    (on the terminal: the token is typed, never an argument);
# 5a. with --with-proxy, turns on the optional built-in HTTPS proxy (Caddy; docs/operations.md, section 4b): it
#    writes COMPOSE_PROFILES=proxy, YODA_PROXY_DOMAIN and YODA_PROXY_CERT_MODE (plus YODA_PROXY_ACME_EMAIL, and
#    --http-port / --https-port when not 80 and 443) into the new .env, and for --cert-mode files copies --cert and
#    --key into proxy/certs/ (the key 0600). Modes: internal (default; Caddy's own CA, whose public root deploy.sh
#    copies to proxy/root.crt for the staff PCs), files (the organisation's certificate: it must name --domain,
#    match --key and not have expired, checked with openssl; a warning under 30 days left) or acme (Let's Encrypt,
#    only when the host is reachable from the internet on 80 and 443, never other ports; needs --acme-email;
#    --acme-staging uses Let's Encrypt's staging CA for a trial). The releases before 1.1.0 have no proxy: refused.
#    Without it, HTTPS comes from your own reverse proxy (section 1), as before;
# 6. pins the image prefix in release.env (never Docker Hub), then runs ops/deploy/deploy.sh (pull, pin release.env
#    with the bundle's image digests, init, migrate, up, wait for /api/ready), which prints the setup wizard's
#    address and the setup-token command while setup is not finished. When pulling from ghcr.io fails (packages
#    not public yet), it offers `docker login ghcr.io` on a terminal and deploys once more.
#
# Env (the options win): YODA_VERSION, YODA_DIR, YODA_RELEASE_BASE_URL, YODA_IMAGE_PREFIX,
# YODA_IGNORE_BUNDLE_DIGESTS=1 (passed to deploy.sh: run the tags of a mirror that rebuilt the images), and
# YODA_RELEASE_PUBKEY (a minisign public key replacing the embedded one; tests and key rotation only).
# For tests (each has a safe default): YODA_TTY (the terminal questions are read from, /dev/tty; empty: none),
# YODA_OS_RELEASE (/etc/os-release), YODA_LATEST_URL and YODA_RELEASES_API (where "latest" is looked up).
# POSIX sh. Run it as the deploy user: it uses sudo only for what it asked about (packages, the docker group,
# creating --dir), and as root it needs none.
set -eu

# The constants are a function too (called first by main), their lines unindented for the tools that read them
# (bundle.sh sets RELEASE_VERSION; the release workflow reads RELEASE_PUBKEY_EMBEDDED): cut short in the middle of
# one, a line must never run as a command.
constants() {
# The release signing public key (minisign key id C73EF0AF404BAE84, the second line of keys/yoda-release.pub;
# docs/releasing.md, "Verifying releases"). A fork or mirror with its own key replaces it; a placeholder containing
# REPLACE-WITH is refused below.
RELEASE_PUBKEY_EMBEDDED='RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j'
# Where releases are published (D1): GitHub Release assets and GHCR images. "{version}" becomes the version.
# An internal mirror overrides both: --base-url / YODA_RELEASE_BASE_URL and --image-prefix / YODA_IMAGE_PREFIX.
DEFAULT_BASE_URL='https://github.com/tantee/yoda/releases/download/v{version}/'
DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'
# The release this install.sh belongs to: bundle.sh sets it in the published copy (empty in the repository, where
# the default is the latest release). --version always wins.
RELEASE_VERSION=''
# "latest": the redirect of releases/latest to releases/tag/v<version>, else the API's tag_name.
LATEST_URL='https://github.com/tantee/yoda/releases/latest'
RELEASES_API='https://api.github.com/repos/tantee/yoda/releases/latest'
MIN_COMPOSE='2.24'
MIN_ENGINE=24
MIN_FREE_KB=10485760
# Docker Engine from Docker's own repository (https://docs.docker.com/engine/install/).
DOCKER_REPO='https://download.docker.com/linux'
DOCKER_PACKAGES='docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
# The fingerprint of Docker's repository signing key (https://docs.docker.com/engine/install/ubuntu/), for apt.
DOCKER_KEY_FPR='9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

say() { printf 'install: %s\n' "$*"; }
die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
is_version() { printf '%s\n' "$1" | grep -Eq "$VERSION_RE"; }

usage() {
  cat <<'EOF'
usage: curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh -s -- [options]
       sh install.sh [options]
  --version X.Y.Z     the release (default: the latest; next to a signed SHA256SUMS, the release it names)
  --dir PATH          the install directory (default /srv/yoda)
  --yes, -y           answer yes to every question (installing missing tools, the docker group, creating --dir)
  --base-url URL      an internal mirror's release directory ("{version}" becomes the version; needs --version)
  --image-prefix P    the images' registry path (default: the bundle's, ghcr.io/tantee/yoda)
  --no-login          never run docker login
  --with-proxy --domain NAME [--cert-mode internal|files|acme] [--cert FILE --key FILE]
    [--acme-email ADDRESS [--acme-staging]] [--http-port N] [--https-port N]   (release 1.1.0 or later)
EOF
  exit "${1:-0}"
}

# Whether a PEM certificate names a host as a browser checks it: its subject alternative names only (DNS, with a
# wildcard for one label, or IP), never the subject's CN; LibreSSL has no `openssl x509 -checkhost`.
cert_names_host() {
  h=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  w=$h
  case "$h" in *.*) w="*.${h#*.}" ;; esac
  openssl x509 -in "$1" -noout -text 2>/dev/null | grep -Eo '(DNS|IP Address):[^, ]+' |
    sed -e 's/^DNS://' -e 's/^IP Address://' | tr '[:upper:]' '[:lower:]' | grep -Fxq -e "$h" -e "$w"
}

# --- questions: on the terminal, also when piped (stdin is then the script) ------------------------------------
tty_ok() { [ -n "$tty" ] && (: <"$tty") 2>/dev/null; }
# ask QUESTION [ALTERNATIVE]: yes with --yes, else the answer typed on the terminal. With neither, it stops (never
# assumes yes), naming --yes and the alternative.
ask() {
  if [ "$assume_yes" = yes ]; then
    say "$1 yes (--yes)"
    return 0
  fi
  tty_ok || die "$1 There is no terminal to ask on (piped without one, or unattended), and install.sh never assumes yes: run it again with --yes${2:+, or $2}"
  printf 'install: %s [y/N] ' "$1" >>"$tty"
  answer=''
  IFS= read -r answer <"$tty" || :
  case "$answer" in
    [Yy] | [Yy][Ee][Ss]) return 0 ;;
  esac
  return 1
}

# --- root: sudo only for what was asked -----------------------------------------------------------------------
is_root() { [ "$(id -u)" = 0 ]; }
need_root() {
  is_root || have sudo || die "$1 needs root, and sudo is missing: run install.sh as root, or install sudo (and allow $(id -un) to use it), then run it again"
}
as_root() {
  if is_root; then "$@"; else sudo "$@"; fi
}
# After a yes: sudo must work now, not hang on a password nobody can type (piped, --yes, no terminal).
sudo_ready() {
  is_root && return 0
  sudo -n true 2>/dev/null || tty_ok ||
    die 'sudo needs a password and there is no terminal (run it in a terminal, or as root)'
  sudo -v || die 'sudo -v failed: this user may not use sudo here'
}

# --- the system ---------------------------------------------------------------------------------------------------
os_field() {
  sed -n "s/^$1=//p" "$os_release" 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/"
}
# debian (Debian, Ubuntu and their derivatives), rhel (exactly RHEL, CentOS, Rocky, AlmaLinux, Fedora and Oracle
# Linux: Docker's repository serves those; Amazon Linux and other look-alikes are unknown) or unknown.
os_family() {
  [ -r "$os_release" ] || { echo unknown; return 0; }
  case "$(os_field ID)" in
    rhel | centos | rocky | almalinux | fedora | ol) echo rhel; return 0 ;;
  esac
  case " $(os_field ID) $(os_field ID_LIKE) " in
    *' debian '* | *' ubuntu '*) echo debian ;;
    *) echo unknown ;;
  esac
}
# ver_ge FOUND MAJOR MINOR: FOUND (x.y[.z][suffix], a leading v ignored) is MAJOR.MINOR or later.
ver_ge() {
  v=${1#v}
  vmaj=${v%%[!0-9]*}
  vrest=${v#"$vmaj"}
  vrest=${vrest#.}
  vmin=${vrest%%[!0-9]*}
  [ -n "$vmaj" ] || return 1
  [ -n "$vmin" ] || vmin=0
  [ "$vmaj" -gt "$2" ] || { [ "$vmaj" -eq "$2" ] && [ "$vmin" -ge "$3" ]; }
}

# The Docker daemon's version (engine), or why it cannot be reached (docker_err).
probe_engine() {
  if out=$(docker version --format '{{.Server.Version}}' 2>&1) && [ -n "$out" ]; then
    engine=$out
    docker_err=''
  else
    engine=''
    docker_err=$(printf '%s' "$out" | tr '\n' ' ')
  fi
}

lack() {
  missing="$missing $1"
  report="$report
  - $2"
}
# What is missing or too old: $missing (curl tar sha256sum minisign openssl docker compose), $report (found vs
# needed, one line each) and $docker_state (ok, missing, access: this user may not use it, down: no daemon).
check_deps() {
  missing=''
  report=''
  docker_state=ok
  engine_old=no
  compose_state=ok
  have curl || lack curl 'curl: not found (downloads the release)'
  have tar || lack tar 'tar: not found (unpacks the release)'
  have sha256sum || have shasum || lack sha256sum 'sha256sum or shasum: not found (checks the release checksum)'
  have minisign || lack minisign 'minisign: not found (checks the release signature)'
  [ "$need_openssl" = no ] || have openssl || lack openssl 'openssl: not found (checks the --cert-mode files certificate)'
  if ! have docker; then
    docker_state=missing
    lack docker "Docker Engine: not found, needs $MIN_ENGINE or later"
    lack compose "Docker Compose plugin: not found, needs v$MIN_COMPOSE or later"
    return 0
  fi
  if compose=$(docker compose version --short 2>/dev/null) && [ -n "$compose" ]; then
    ver_ge "$compose" 2 24 || { compose_state=old; lack compose "Docker Compose: found $compose, needs v$MIN_COMPOSE or later"; }
  else
    compose_state=missing
    lack compose "Docker Compose plugin: not found (docker compose version failed), needs v$MIN_COMPOSE or later"
  fi
  probe_engine
  if [ -n "$engine" ]; then
    ver_ge "$engine" "$MIN_ENGINE" 0 || { engine_old=yes; lack docker "Docker Engine: found $engine, needs $MIN_ENGINE or later"; }
    return 0
  fi
  # No daemon to ask: the client's version says whether it is too old anyway.
  client=$(docker --version 2>/dev/null | sed -n 's/^Docker version \([0-9][0-9.]*\).*/\1/p')
  if [ -n "$client" ] && ! ver_ge "$client" "$MIN_ENGINE" 0; then
    engine_old=yes
    lack docker "Docker Engine: found $client (client), needs $MIN_ENGINE or later"
  fi
  case "$docker_err" in
    *[Pp]ermission\ denied*) docker_state=access ;;
    *) docker_state=down ;;
  esac
}

# Whether the installed Docker came from Docker's own repository (an upgrade from there is safe).
docker_from_repo() {
  case "$1" in
    debian) dpkg -s docker-ce >/dev/null 2>&1 ;;
    rhel) rpm -q docker-ce >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

manual_steps() {
  say "$1. Install them yourself, then run install.sh again:"
  said_docker=no
  for m in $missing; do
    case "$m" in
      sha256sum) echo '  - sha256sum (coreutils) or shasum: your package manager' ;;
      minisign) echo '  - minisign: your package manager, or https://jedisct1.github.io/minisign/' ;;
      docker | compose)
        [ "$said_docker" = yes ] || echo "  - Docker Engine $MIN_ENGINE or later with the Compose plugin v$MIN_COMPOSE or later: https://docs.docker.com/engine/install/"
        said_docker=yes
        ;;
      *) echo "  - $m: your package manager" ;;
    esac
  done
}

# Docker is there but not usable for Yoda, and not Docker's own packages: explained, never replaced behind the
# user's back (other containers may run on it).
explain_distro_docker() {
  real=$(command -v docker)
  case "$real" in
    */snap/*)
      say "Docker here is the snap ($real): install.sh does not change it. Either make sure it gives Docker Engine"
      say "$MIN_ENGINE or later with Compose v$MIN_COMPOSE or later yourself, or switch to Docker's packages:"
      say '  sudo snap remove docker   (its images, containers and volumes go with it: back them up first)'
      say "  then run install.sh again: it then offers Docker Engine from $DOCKER_REPO ($DOCKER_PACKAGES)."
      return 0
      ;;
  esac
  if [ "$1" = debian ]; then
    if [ "$engine_old" = no ] && [ "$compose_state" = missing ]; then
      say "Docker is installed from the distribution, without the Compose plugin. Ubuntu's and Debian's own package"
      say "for it (docker-compose-v2) can be older than Compose v$MIN_COMPOSE; check before using it:"
      say "  apt-cache policy docker-compose-v2   (needs $MIN_COMPOSE or later), then: sudo apt-get install docker-compose-v2"
      say 'Or switch to Docker'"'"'s packages (below).'
    else
      say "Docker is installed from the distribution (docker.io, docker-compose-v2), not from Docker's own"
      say "repository, and it is older than Yoda needs (Engine $MIN_ENGINE+, Compose v$MIN_COMPOSE+); install.sh does not replace it."
    fi
    remove='sudo apt-get remove docker.io docker-compose-v2 docker-compose docker-doc podman-docker'
  else
    say "Docker here is not from Docker's own repository (the distribution's moby-engine, or podman-docker), and it"
    say "is not what Yoda needs (Engine $MIN_ENGINE+ with Compose v$MIN_COMPOSE+); install.sh does not replace it."
    remove='sudo dnf remove docker docker-client docker-common podman-docker moby-engine'
  fi
  say 'To switch to Docker'"'"'s packages:'
  say "  $remove"
  say '  (images, containers and volumes stay in /var/lib/docker), then run install.sh again: it then offers'
  say "  Docker Engine from $DOCKER_REPO ($DOCKER_PACKAGES)."
}

# The distribution in Docker's repository paths.
docker_distro() {
  case " $(os_field ID) $(os_field ID_LIKE) " in
    *' ubuntu '*) echo ubuntu ;;
    *' debian '*) echo debian ;;
    *)
      case "$(os_field ID)" in
        fedora) echo fedora ;;
        rhel) echo rhel ;;
        *) echo centos ;;
      esac
      ;;
  esac
}
# The release name in Docker's apt repository: a derivative's base (DEBIAN_CODENAME, LMDE; UBUNTU_CODENAME, Mint)
# before its own (VERSION_CODENAME). Empty when there is none or it is not a plain name.
docker_codename() {
  for f in DEBIAN_CODENAME UBUNTU_CODENAME VERSION_CODENAME; do
    c=$(os_field "$f")
    [ -z "$c" ] || break
  done
  printf '%s\n' "$c" | grep -Ex '[a-z0-9-]+' || :
}
# Docker's apt repository must have a release for this system (it has none for kali-rolling or LMDE's own names):
# checked before anything is written.
docker_apt_release() {
  dist=$(docker_distro)
  codename=$(docker_codename)
  [ -n "$codename" ] || {
    missing='docker'
    manual_steps "cannot tell this system's release name (DEBIAN_CODENAME, UBUNTU_CODENAME or VERSION_CODENAME in $os_release) for Docker's repository"
    exit 1
  }
  curl -fsI --proto '=https' --proto-redir '=https' "$DOCKER_REPO/$dist/dists/$codename/Release" >/dev/null 2>&1 || {
    missing='docker'
    manual_steps "Docker's apt repository has no release \"$codename\" ($DOCKER_REPO/$dist/dists/$codename/), so install.sh cannot add it"
    exit 1
  }
}
# An apt source for download.docker.com that is not install.sh's own docker.list: a second one makes apt fail
# ("Conflicting values set for option Signed-By"), so install.sh stops instead of adding it.
docker_apt_existing() {
  for f in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.list "$apt_dir"/sources.list.d/*.sources; do
    [ -f "$f" ] && [ "$f" != "$apt_dir/sources.list.d/docker.list" ] || continue
    if grep -v '^[[:space:]]*#' "$f" | grep -q 'download\.docker\.com'; then
      if grep -v '^[[:space:]]*#' "$f" | grep -qi 'signed-by'; then
        how_signed='with its own signed-by key'
      else
        how_signed='without signed-by (trusted through the old apt-key keyring)'
      fi
      say "Docker's apt repository is already configured in $f, $how_signed. install.sh does not add a second"
      say "entry (apt refuses two with different keys). Install Docker from that entry yourself (sudo apt-get install $DOCKER_PACKAGES),"
      say "or remove it and run install.sh again: it then adds $apt_dir/sources.list.d/docker.list with the key in $apt_dir/keyrings/docker.asc."
      exit 1
    fi
  done
}
# Docker's key: a PGP public key, and with gpg here exactly Docker's fingerprint.
docker_key_check() {
  grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$1" || die "the downloaded Docker repository key ($DOCKER_REPO/$dist/gpg) is not a PGP public key: nothing was changed"
  if have gpg; then
    fprs=$(gpg --batch --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }')
    printf '%s\n' "$fprs" | grep -qx "$DOCKER_KEY_FPR" ||
      die "the downloaded Docker repository key is not Docker's (fingerprint $DOCKER_KEY_FPR; got: $(printf '%s' "$fprs" | tr '\n' ' ')): nothing was changed"
    say "Docker's repository key: fingerprint $DOCKER_KEY_FPR (checked with gpg)"
  else
    say "warning: gpg is not here, so the Docker repository key's fingerprint is not checked (it came over https from download.docker.com; apt checks the repository with it)"
  fi
}

# The plan behind the one question: every command install.sh then runs, as root through sudo when not root.
plan() {
  r=${how:+'sudo '}
  if [ "$family" = debian ]; then
    say "  ${r}apt-get update"
    case " $pkgs " in
      *' minisign '*)
        [ "$(docker_distro)" != ubuntu ] ||
          say "  if apt does not know minisign then: ${r}apt-get install -y software-properties-common (unless add-apt-repository is here), ${r}add-apt-repository -y universe, ${r}apt-get update"
        ;;
    esac
    [ -z "$pkgs" ] || say "  ${r}apt-get install -y $pkgs"
    if [ "$docker_repo" = yes ]; then
      say "  Docker's apt repository ($DOCKER_REPO/$(docker_distro), release $(docker_codename)): download its GPG key"
      say "    ($DOCKER_REPO/$(docker_distro)/gpg; fingerprint $DOCKER_KEY_FPR, checked when gpg is here) into $apt_dir/keyrings/docker.asc,"
      say "    write $apt_dir/sources.list.d/docker.list, ${r}apt-get update, ${r}apt-get install -y $DOCKER_PACKAGES"
      say "    (if that fails, both files are removed again)"
    fi
  else
    case " $pkgs " in
      *' minisign '*) say "  if dnf does not know minisign: ${r}$dnf install -y epel-release (EPEL)" ;;
    esac
    [ -z "$pkgs" ] || say "  ${r}$dnf install -y $pkgs"
    if [ "$docker_repo" = yes ]; then
      say "  ${r}$dnf install -y dnf-plugins-core, then ${r}$dnf config-manager --add-repo $DOCKER_REPO/$(docker_distro)/docker-ce.repo"
      say "    (Docker's repository; dnf imports its GPG key at the install), ${r}$dnf install -y $DOCKER_PACKAGES"
      say "    (if that fails, the repository file is removed again)"
    fi
  fi
  if [ "$docker_repo" = yes ]; then
    have systemctl && [ -d /run/systemd/system ] && say "  ${r}systemctl enable --now docker   (start Docker now and at boot)"
    if ! is_root; then
      say "  ${r}usermod -aG docker $user   (the docker group is root-equivalent: whoever is in it controls this host;"
      say '    this run uses the group through sg docker, new logins get it after logging out and back in)'
    fi
  fi
}

# Installs what check_deps found missing, after asking. Never returns on a system it cannot handle.
install_deps() {
  family=$(os_family)
  osid=$(os_field ID)
  [ -n "$osid" ] || osid=unknown
  if [ "$family" = unknown ]; then
    manual_steps "install.sh can install them on Debian, Ubuntu and the RHEL family (RHEL, CentOS, Rocky, AlmaLinux, Fedora, Oracle Linux) only; this system is $osid ($os_release)"
    exit 1
  fi
  pkgs=''
  docker_repo=no
  for m in $missing; do
    case "$m" in
      sha256sum) pkgs="$pkgs coreutils" ;;
      docker | compose) docker_repo=yes ;;
      *) pkgs="$pkgs $m" ;;
    esac
  done
  if [ "$docker_repo" = yes ] && [ "$docker_state" != missing ] && ! docker_from_repo "$family"; then
    explain_distro_docker "$family"
    exit 1
  fi
  # Docker's repository key comes over https with curl.
  [ "$docker_repo" = no ] || pkgs="ca-certificates curl$pkgs"
  # shellcheck disable=SC2086 # a list of package names, each once
  [ -z "$pkgs" ] || pkgs=$(printf '%s\n' $pkgs | awk '!seen[$0]++' | tr '\n' ' ')
  pkgs=${pkgs% }
  user=$(id -un)
  dnf=dnf
  [ "$family" = debian ] || have dnf || dnf=yum
  need_root 'installing the missing tools'
  if [ "$family" = debian ] && [ "$docker_repo" = yes ]; then
    docker_apt_existing
    # Without curl yet, the release is checked after apt installed it, still before anything Docker is written.
    ! have curl || docker_apt_release
  fi
  how='sudo'
  ! is_root || how=''
  say "install.sh can install them now (${how:-as root}), with:"
  plan
  ask 'Install them now?' 'install them yourself (above) and run install.sh again' ||
    die 'nothing was installed: install them yourself (above), then run install.sh again'
  sudo_ready
  if [ "$family" = debian ]; then install_debian; else install_rhel; fi
  if [ "$docker_repo" = yes ]; then
    if have systemctl && [ -d /run/systemd/system ]; then
      as_root systemctl enable --now docker || say 'warning: could not start Docker (systemctl enable --now docker)'
    fi
    if ! is_root; then
      as_root usermod -aG docker "$user" || die "could not add $user to the docker group (usermod -aG docker $user)"
      group_added=yes
    fi
  fi
}

apt_get() { as_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"; }
# Takes Docker's apt source and key away again, so a failed setup never leaves apt broken.
docker_apt_undo() {
  as_root rm -f "$apt_dir/sources.list.d/docker.list" "$apt_dir/keyrings/docker.asc" || :
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1 || :
  die "$1: removed $apt_dir/sources.list.d/docker.list and $apt_dir/keyrings/docker.asc again, so apt is as before"
}
install_debian() {
  apt_get update || die 'apt-get update failed'
  case " $pkgs " in
    *' minisign '*)
      # Ubuntu ships minisign in universe; enable it when apt does not know the package.
      if [ "$(docker_distro)" = ubuntu ] && ! apt-cache show minisign >/dev/null 2>&1; then
        say 'enabling the universe repository (minisign is in it)'
        have add-apt-repository || apt_get install -y software-properties-common || die 'cannot install software-properties-common (for add-apt-repository)'
        as_root add-apt-repository -y universe || die 'cannot enable the universe repository: sudo add-apt-repository universe'
        apt_get update || die 'apt-get update failed'
      fi
      ;;
  esac
  # shellcheck disable=SC2086 # a list of package names
  [ -z "$pkgs" ] || apt_get install -y $pkgs || die "apt-get install $pkgs failed"
  [ "$docker_repo" = yes ] || return 0
  docker_apt_release
  arch=$(dpkg --print-architecture) || die 'dpkg --print-architecture failed'
  curl -fsSL --proto '=https' --proto-redir '=https' "$DOCKER_REPO/$dist/gpg" -o "$tmp/docker.asc" ||
    die "cannot download Docker's repository key ($DOCKER_REPO/$dist/gpg): nothing was changed"
  docker_key_check "$tmp/docker.asc"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] %s/%s %s stable\n' "$arch" "$DOCKER_REPO" "$dist" "$codename" > "$tmp/docker.list"
  as_root install -m 0755 -d "$apt_dir/keyrings" || die "cannot create $apt_dir/keyrings"
  as_root install -m 0644 "$tmp/docker.asc" "$apt_dir/keyrings/docker.asc" || docker_apt_undo "cannot install $apt_dir/keyrings/docker.asc"
  as_root install -m 0644 "$tmp/docker.list" "$apt_dir/sources.list.d/docker.list" || docker_apt_undo "cannot write $apt_dir/sources.list.d/docker.list"
  apt_get update || docker_apt_undo "apt-get update failed with Docker's repository"
  # shellcheck disable=SC2086 # a list of package names
  apt_get install -y $DOCKER_PACKAGES || docker_apt_undo "apt-get install $DOCKER_PACKAGES failed"
}

docker_dnf_undo() {
  as_root rm -f "$yum_repos/docker-ce.repo" || :
  die "$1: removed $yum_repos/docker-ce.repo again, so dnf is as before"
}
install_rhel() {
  case " $pkgs " in
    *' minisign '*)
      "$dnf" info minisign >/dev/null 2>&1 || as_root "$dnf" install -y epel-release ||
        die 'minisign comes from EPEL, and epel-release cannot be installed here: enable EPEL for this system, then run install.sh again'
      ;;
  esac
  # shellcheck disable=SC2086 # a list of package names
  [ -z "$pkgs" ] || as_root "$dnf" install -y $pkgs || die "$dnf install $pkgs failed"
  [ "$docker_repo" = yes ] || return 0
  repo="$DOCKER_REPO/$(docker_distro)/docker-ce.repo"
  as_root "$dnf" install -y dnf-plugins-core || die "$dnf install dnf-plugins-core failed"
  # dnf 4, then dnf 5's syntax.
  as_root "$dnf" config-manager --add-repo "$repo" 2>/dev/null || as_root "$dnf" config-manager addrepo --from-repofile="$repo" ||
    docker_dnf_undo "cannot add Docker's repository ($repo)"
  # shellcheck disable=SC2086 # a list of package names
  as_root "$dnf" install -y $DOCKER_PACKAGES || docker_dnf_undo "$dnf install $DOCKER_PACKAGES failed"
}

# This run uses the docker group although this login does not have it yet: a `docker` first on PATH that runs
# the real one through `sg docker` (as this user, files stay this user's), for deploy.sh too.
use_docker_group() {
  real=$(command -v docker)
  case "$real" in
    /*) ;;
    *) die "cannot find the docker binary ($real)" ;;
  esac
  case "$real" in *\'*) die "unusual docker path: $real" ;; esac
  have sg || die "sg is missing, so this run cannot use the docker group: log out and back in (or run: newgrp docker), then run install.sh again"
  mkdir -p "$tmp/bin"
  {
    printf '#!/bin/sh\n# install.sh: docker with the docker group, for this run only (this login does not have it yet).\n'
    printf "real='%s'\n" "$real"
    cat <<'SHIM'
q=''
for a; do
  q="$q '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"
done
exec sg docker -c "exec '$real'$q"
SHIM
  } > "$tmp/bin/docker"
  chmod 755 "$tmp/bin/docker"
  PATH="$tmp/bin:$PATH"
  export PATH
  via_group=yes
}

# The daemon answers this user, or install.sh stops saying why.
docker_access() {
  probe_engine
  if [ -z "$engine" ]; then
    case "$docker_err" in
      *[Pp]ermission\ denied*) docker_group ;;
      *) docker_start ;;
    esac
  fi
  ver_ge "$engine" "$MIN_ENGINE" 0 || die "Docker Engine $MIN_ENGINE or later is required (found $engine)"
}
docker_group() {
  is_root && die "cannot talk to the Docker daemon as root: $docker_err"
  user=$(id -un)
  if ! id -nG "$user" | tr ' ' '\n' | grep -qx docker; then
    say "$user may not run docker (not in the docker group): $docker_err"
    say 'the docker group is root-equivalent: whoever is in it controls this host (that is what running docker means)'
    ask "Add $user to the docker group (sudo usermod -aG docker $user)?" "add it yourself (sudo usermod -aG docker $user, then log out and back in), or run install.sh with sudo" ||
      die "$user may not run docker: sudo usermod -aG docker $user, then log out and back in and run install.sh again, or run install.sh with sudo"
    need_root 'adding you to the docker group'
    sudo_ready
    as_root usermod -aG docker "$user" || die "could not add $user to the docker group"
    group_added=yes
  fi
  use_docker_group
  probe_engine
  [ -n "$engine" ] || die "cannot talk to the Docker daemon through the docker group either: $docker_err"
}
docker_start() {
  if have systemctl && [ -d /run/systemd/system ]; then
    ask "cannot talk to the Docker daemon (not running?): start it now (sudo systemctl enable --now docker)?" 'start it yourself: sudo systemctl enable --now docker' ||
      die 'cannot talk to the Docker daemon: start it (sudo systemctl enable --now docker), then run install.sh again'
    need_root 'starting Docker'
    sudo_ready
    as_root systemctl enable --now docker || die 'systemctl enable --now docker failed'
    probe_engine
    case "$docker_err" in *[Pp]ermission\ denied*) docker_group ;; esac
  fi
  [ -n "$engine" ] || die "cannot talk to the Docker daemon: is it running, and may this user run docker (the docker group)? ${docker_err:+($docker_err) }Start it (sudo systemctl start docker, or sudo service docker start), then run install.sh again"
}

ensure_deps() {
  check_deps
  if [ -n "$missing" ]; then
    say "missing or too old:$report"
    install_deps
    check_deps
    [ -z "$missing" ] || die "still missing or too old after installing:$report"
  fi
  docker_access
  if have sha256sum; then hasher=sha256sum; else hasher=shasum; fi
}

# --- the release ------------------------------------------------------------------------------------------------
# https only (also after redirects), unless the URL itself is http:// (a mirror's --base-url, warned about).
curl_get() {
  url=$1
  shift
  case "$url" in
    https://*) curl --proto '=https' --proto-redir '=https' "$@" "$url" ;;
    *) curl "$@" "$url" ;;
  esac
}
fetch() {
  case "$1" in
    https://*) curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 -o "$2" "$1" ;;
    *) curl -fsSL --retry 2 -o "$2" "$1" ;;
  esac || die "download failed: $1"
}
sha256() {
  if [ "$hasher" = sha256sum ]; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}
# The SHA-256 the signed SHA256SUMS lists for a file name.
listed() { awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS"; }

# install.sh as a file (sh install.sh), not read from a pipe (curl ... | sh: $0 is then the shell).
script_file() {
  case "$0" in
    sh | -sh | */sh | dash | -dash | */dash | bash | -bash | */bash | ksh | */ksh | zsh | */zsh | busybox | */busybox) return 1 ;;
  esac
  [ -f "$0" ]
}

# The signature covers SHA256SUMS and its trusted comment, which names the release: an older signed file served
# for this version is refused too. Sets signed_for.
verify_sums() {
  sigout=$(minisign -V -P "$pubkey" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig" 2>&1) ||
    die 'signature check FAILED for SHA256SUMS: refusing to install (wrong key, or the files were changed)'
  signed_for=$(printf '%s\n' "$sigout" | sed -n 's/^Trusted comment: yoda release \([0-9A-Za-z.-]*\)$/\1/p' | head -n 1)
}
signed_for_version() {
  printf '%s\n' "$sigout" | grep -qFx "Trusted comment: yoda release $version" ||
    die "signature check FAILED: SHA256SUMS was not signed for release $version${signed_for:+ (it names $signed_for)}"
}

latest_version() {
  if [ -z "$latest_url$releases_api" ]; then
    [ "$base_given" = no ] ||
      die 'an internal mirror (--base-url) has no "latest": pass --version <x.y.z> (see CHANGELOG.md)'
    latest_url=$LATEST_URL
    releases_api=$RELEASES_API
  fi
  v=''
  if [ -n "$latest_url" ]; then
    say "finding the latest release ($latest_url)"
    case "$latest_url" in
      https://*) loc=$(curl -fsSI --proto '=https' --retry 2 -o /dev/null -w '%{redirect_url}' "$latest_url" 2>/dev/null) || loc='' ;;
      *) loc=$(curl -fsSI --retry 2 -o /dev/null -w '%{redirect_url}' "$latest_url" 2>/dev/null) || loc='' ;;
    esac
    case "$loc" in
      */releases/tag/*) v=${loc##*/releases/tag/} ;;
    esac
    v=${v#v}
  fi
  if ! is_version "$v" && [ -n "$releases_api" ]; then
    v=$(curl_get "$releases_api" -fsSL --retry 2 -H 'Accept: application/vnd.github+json' 2>/dev/null |
      sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*$/\1/p' | head -n 1) || v=''
  fi
  from=$latest_url
  [ -z "$releases_api" ] || from="${from:+$from, }$releases_api"
  is_version "$v" || die "cannot find the latest release ($from): pass --version <x.y.z> (https://github.com/tantee/yoda/releases)"
  version=$v
  say "latest release: $version"
}

# The release: --version, else the one this install.sh was published with (RELEASE_VERSION, so a published N
# never resolves N+1), else the one a signed SHA256SUMS next to it names, else the latest (also --version latest).
resolve_version() {
  if [ -z "$version" ] && [ "$want_latest" = no ] && [ -n "$RELEASE_VERSION" ]; then
    is_version "$RELEASE_VERSION" || die "this install.sh names no valid release ($RELEASE_VERSION)"
    version=$RELEASE_VERSION
    say "release $version (the one this install.sh belongs to; --version picks another)"
  fi
  local_dir=''
  if script_file; then
    d=$(dirname "$0")
    if [ -f "$d/SHA256SUMS" ] && [ -f "$d/SHA256SUMS.minisig" ]; then
      local_dir=$(cd "$d" && pwd)
    fi
  fi
  if [ -n "$local_dir" ]; then
    say "using the SHA256SUMS and SHA256SUMS.minisig next to install.sh ($local_dir)"
    cp "$local_dir/SHA256SUMS" "$local_dir/SHA256SUMS.minisig" "$tmp/" || die "cannot read $local_dir/SHA256SUMS"
    verify_sums
    if [ -z "$version" ]; then
      is_version "$signed_for" || die 'signature check FAILED: the signed SHA256SUMS names no release'
      version=$signed_for
    fi
    [ "$signed_for" = "$version" ] ||
      die "the SHA256SUMS next to install.sh ($local_dir) is signed for release ${signed_for:-(none)}, not $version: stale files from another download? Run install.sh from a clean directory (or with that release's files)"
    signed_for_version
    # This very script must be the release's.
    want=$(listed install.sh)
    [ -n "$want" ] && [ "$(sha256 "$0")" = "$want" ] ||
      die "checksum MISMATCH: $0 is not the install.sh the signed SHA256SUMS next to it lists: refusing (download it again)"
  elif [ -z "$version" ]; then
    latest_version
  fi
  is_version "$version" || die "not a release version: $version (expected x.y.z)"
}

check_proxy_version() {
  [ "$with_proxy" = yes ] || return 0
  # The proxy came with 1.1.0: an older bundle has no proxy service, so the flag would do nothing.
  case "$version" in
    0.* | 1.0.*) die "the built-in HTTPS proxy (--with-proxy) needs release 1.1.0 or later; this is $version: install a newer release, or put your own reverse proxy in front (docs/operations.md, section 1)" ;;
  esac
}

# --- arguments --------------------------------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || usage 2; version=$2; shift 2 ;;
      --version=*) version=${1#*=}; shift ;;
      --dir) [ $# -ge 2 ] || usage 2; dir=$2; shift 2 ;;
      --dir=*) dir=${1#*=}; shift ;;
      --base-url) [ $# -ge 2 ] || usage 2; base=$2; base_given=yes; shift 2 ;;
      --base-url=*) base=${1#*=}; base_given=yes; shift ;;
      --image-prefix) [ $# -ge 2 ] || usage 2; prefix=$2; shift 2 ;;
      --image-prefix=*) prefix=${1#*=}; shift ;;
      --no-login) login=no; shift ;;
      -y | --yes) assume_yes=yes; shift ;;
      --with-proxy) with_proxy=yes; shift ;;
      --domain) [ $# -ge 2 ] || usage 2; domain=$2; shift 2 ;;
      --domain=*) domain=${1#*=}; shift ;;
      --cert-mode) [ $# -ge 2 ] || usage 2; cert_mode=$2; shift 2 ;;
      --cert-mode=*) cert_mode=${1#*=}; shift ;;
      --cert) [ $# -ge 2 ] || usage 2; cert=$2; shift 2 ;;
      --cert=*) cert=${1#*=}; shift ;;
      --key) [ $# -ge 2 ] || usage 2; key=$2; shift 2 ;;
      --key=*) key=${1#*=}; shift ;;
      --acme-email) [ $# -ge 2 ] || usage 2; acme_email=$2; shift 2 ;;
      --acme-email=*) acme_email=${1#*=}; shift ;;
      --acme-staging) acme_staging=yes; shift ;;
      --http-port) [ $# -ge 2 ] || usage 2; http_port=$2; shift 2 ;;
      --http-port=*) http_port=${1#*=}; shift ;;
      --https-port) [ $# -ge 2 ] || usage 2; https_port=$2; shift 2 ;;
      --https-port=*) https_port=${1#*=}; shift ;;
      -h | --help) usage 0 ;;
      *) printf 'install: unknown option %s\n' "$1" >&2; usage 2 ;;
    esac
  done
}

# Everything that needs no tool and no network: before the dependency check, so a typo costs nothing.
check_args() {
  case "$version" in
    '') ;;
    latest) version='' want_latest=yes ;;
    *) is_version "$version" || die "not a pinned release version: $version (expected x.y.z, or leave --version out for the latest)" ;;
  esac
  case "$dir" in
    /*) ;;
    *) die "--dir must be an absolute path: $dir" ;;
  esac
  case "$dir" in
    *[!A-Za-z0-9._/-]*) die "--dir may hold only A-Z a-z 0-9 . _ - /: $dir" ;;
  esac
  # Only files are looked at: before any dependency is installed.
  for f in docker-compose.yml docker-compose.prod.yml release.env ops; do
    [ ! -e "$dir/$f" ] || die "$dir already holds an install ($f); upgrade it with: cd $dir && YODA_VERSION=${version:-<version>} sh ops/deploy/deploy.sh"
  done
  case "$base" in
    https://*) ;;
    http://*) say "warning: $base is not https; the signature check still protects the bundle" ;;
    *) die "--base-url must be an http(s) URL: $base" ;;
  esac
  if [ -n "$prefix" ]; then
    case "$prefix" in
      -* | *[!A-Za-z0-9._:/-]*) die "invalid image prefix: $prefix" ;;
    esac
  fi
  if [ "$pubkey" != "$RELEASE_PUBKEY_EMBEDDED" ]; then
    say 'warning: YODA_RELEASE_PUBKEY replaces the release key built into this script (key id C73EF0AF404BAE84):'
    say "  releases are checked with $pubkey instead. Use it only for tests or a key the release owner announced."
  fi
  # The built-in HTTPS proxy (optional; docs/operations.md, section 4b). Every value goes into .env: plain words only.
  if [ "$with_proxy" = yes ]; then
    [ -z "$version" ] || check_proxy_version
    [ -n "$domain" ] || die '--with-proxy needs --domain <the name staff open, e.g. portal.example.org>'
    printf '%s\n' "$domain" | grep -Eqx '([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?' ||
      die "--domain must be a host name such as portal.example.org (no scheme, port or path): $domain"
    cert_mode=${cert_mode:-internal}
    case "$cert_mode" in
      internal | files | acme) ;;
      *) die "--cert-mode must be internal, files or acme: $cert_mode" ;;
    esac
    if [ "$cert_mode" = files ]; then
      { [ -n "$cert" ] && [ -n "$key" ]; } || die '--cert-mode files needs --cert <certificate chain, PEM> and --key <private key, PEM>'
      { [ -f "$cert" ] && [ -r "$cert" ]; } || die "cannot read the certificate $cert"
      { [ -f "$key" ] && [ -r "$key" ]; } || die "cannot read the private key $key"
      grep -q -- '-----BEGIN CERTIFICATE-----' "$cert" || die "$cert is not a PEM certificate (-----BEGIN CERTIFICATE-----)"
      grep -Eq -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' "$key" || die "$key is not a PEM private key"
      need_openssl=yes
    elif [ -n "$cert$key" ]; then
      die "--cert and --key are for --cert-mode files only (this is $cert_mode)"
    fi
    if [ "$cert_mode" = acme ]; then
      [ -n "$acme_email" ] || die '--cert-mode acme needs --acme-email <the address Let'"'"'s Encrypt writes to>'
      printf '%s\n' "$acme_email" | grep -Eqx '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+' || die "not an email address: $acme_email"
    elif [ -n "$acme_email" ]; then
      die "--acme-email is for --cert-mode acme only (this is $cert_mode)"
    fi
    [ "$acme_staging" = no ] || [ "$cert_mode" = acme ] || die "--acme-staging is for --cert-mode acme only (this is $cert_mode)"
    for p in "$http_port" "$https_port"; do
      case "$p" in
        '') ;;
        *[!0-9]* | 0*) die "not a port number: $p" ;;
        *) [ "$p" -le 65535 ] || die "not a port number: $p" ;;
      esac
    done
    if [ "$cert_mode" = acme ]; then
      case "$http_port:$https_port" in
        :443 | 80:443 | : | 80:) ;;
        *) die '--cert-mode acme needs ports 80 and 443 (Let'"'"'s Encrypt checks the name there): drop --http-port and --https-port, or use internal or files' ;;
      esac
    fi
    if [ -f "$dir/.env" ] && grep -Eq '^[[:space:]]*(COMPOSE_PROFILES|YODA_PROXY_[A-Z_]*|YODA_TRUSTED_PROXY_HOPS)[[:space:]]*=' "$dir/.env"; then
      die "$dir/.env already sets COMPOSE_PROFILES, YODA_TRUSTED_PROXY_HOPS or a YODA_PROXY_ value: set the built-in proxy there by hand (docs/operations.md, section 4b), or remove those lines"
    fi
    [ "$cert_mode" != acme ] ||
      say "warning: --cert-mode acme works only when $domain points at this host and it is reachable from the internet on ports 80 and 443"
  elif [ -n "$domain$cert_mode$cert$key$acme_email$http_port$https_port" ] || [ "$acme_staging" = yes ]; then
    die '--domain, --cert-mode, --cert, --key, --acme-email, --acme-staging, --http-port and --https-port go with --with-proxy'
  fi
  case "$pubkey" in
    *REPLACE-WITH*) die 'this install.sh has no release public key yet (placeholder); get the published install.sh, or set YODA_RELEASE_PUBKEY to the key the release owner gave you' ;;
    *[!A-Za-z0-9+/=]*) die 'the release public key is not a minisign key' ;;
  esac
}

# The organisation certificate (files mode), with openssl: what Caddy would refuse or browsers reject, before
# anything is written (caddy validate checks the pair again on every deploy).
check_cert() {
  [ "$with_proxy" = yes ] && [ "$cert_mode" = files ] || return 0
  openssl x509 -in "$cert" -noout >/dev/null 2>&1 || die "openssl cannot read the certificate $cert"
  cert_names_host "$cert" "$domain" ||
    die "$cert does not name $domain in its subject alternative names (browsers ignore the subject's CN): get a certificate for that name"
  cpub=$(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null) || cpub=''
  kpub=$(openssl pkey -in "$key" -pubout 2>/dev/null) || die "openssl cannot read the private key $key (an encrypted key? Caddy needs it unencrypted)"
  [ -n "$cpub" ] && [ "$cpub" = "$kpub" ] || die "$key is not the private key of $cert"
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1 || die "$cert has expired"
  openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null 2>&1 ||
    say "warning: $cert expires within 30 days ($(openssl x509 -in "$cert" -noout -enddate | sed 's/^notAfter=//')): renew it soon (docs/operations.md, section 4b)"
}

# --- the install directory ------------------------------------------------------------------------------------
nearest_dir() {
  p=$1
  while [ ! -d "$p" ]; do p=$(dirname "$p"); done
  printf '%s\n' "$p"
}
check_space() {
  probe=$(nearest_dir "$dir")
  free=$(df -Pk "$probe" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$free" in
    '' | *[!0-9]*) say "warning: cannot read the free disk space at $probe (checked for $dir)" ;;
    *)
      [ "$free" -ge "$MIN_FREE_KB" ] ||
        say "warning: only $(awk -v k="$free" 'BEGIN { printf "%.1f", k / 1048576 }') GB free at $probe (checked for $dir); Yoda needs about 10 GB for the database, files and 14 days of backups"
      ;;
  esac
}
# --dir: created as this user, else (asked) with sudo and given to this user.
prepare_dir() {
  if [ -d "$dir" ]; then
    [ -w "$dir" ] || die "$dir exists, but $(id -un) cannot write to it: sudo chown $(id -un) $dir, or choose another --dir"
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null && return 0
  user=$(id -un)
  group=$(id -gn)
  say "cannot create $dir as $user (no write access to $(nearest_dir "$dir"))"
  ask "Create $dir with sudo and give it to $user?" "create it yourself (sudo mkdir -p $dir && sudo chown $user:$group $dir), or choose another --dir" ||
    die "cannot create $dir: create it yourself (sudo mkdir -p $dir && sudo chown $user:$group $dir), or choose another --dir"
  need_root "creating $dir"
  sudo_ready
  as_root mkdir -p "$dir" || die "sudo mkdir -p $dir failed"
  as_root chown "$user:$group" "$dir" || die "sudo chown $user:$group $dir failed"
  [ -w "$dir" ] || die "$dir was created, but $user cannot write to it"
  say "created $dir for $user"
}

# --- main -------------------------------------------------------------------------------------------------------
main() {
  constants
  version="${YODA_VERSION:-}"
  dir="${YODA_DIR:-/srv/yoda}"
  base="${YODA_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}"
  base_given=no
  [ -z "${YODA_RELEASE_BASE_URL:-}" ] || base_given=yes
  prefix="${YODA_IMAGE_PREFIX:-}"
  pubkey="${YODA_RELEASE_PUBKEY:-$RELEASE_PUBKEY_EMBEDDED}"
  tty=${YODA_TTY-/dev/tty}
  os_release=${YODA_OS_RELEASE:-/etc/os-release}
  latest_url=${YODA_LATEST_URL:-}
  releases_api=${YODA_RELEASES_API:-}
  # Tests only: a directory standing for / (apt's and dnf's configuration under it).
  sysroot=${YODA_SYSROOT:-}
  apt_dir="$sysroot/etc/apt"
  yum_repos="$sysroot/etc/yum.repos.d"
  want_latest=no
  login=yes
  assume_yes=no
  with_proxy=no
  domain=''
  cert_mode=''
  cert=''
  key=''
  acme_email=''
  acme_staging=no
  http_port=''
  https_port=''
  need_openssl=no
  group_added=no
  via_group=no
  parse_args "$@"
  check_args

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  # dash runs the EXIT trap only on exit: every signal exits, so the temp directory always goes.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # 1. dependencies, before anything is downloaded.
  ensure_deps

  # 2. the release.
  resolve_version
  check_proxy_version
  check_cert
  check_space

  # 3. download and verify.
  # The version is checked (A-Z a-z 0-9 . -): safe in a sed replacement.
  base=$(printf '%s\n' "$base" | sed "s/{version}/$version/g")
  case "$base" in
    */) ;;
    *) base="$base/" ;;
  esac
  bundle="yoda-$version.tar.gz"
  if [ -z "$local_dir" ]; then
    say "downloading Yoda $version from $base"
    fetch "${base}SHA256SUMS" "$tmp/SHA256SUMS"
    fetch "${base}SHA256SUMS.minisig" "$tmp/SHA256SUMS.minisig"
    verify_sums
    signed_for_version
  fi
  if [ -n "$local_dir" ] && [ -f "$local_dir/$bundle" ]; then
    say "using $bundle next to install.sh"
    cp "$local_dir/$bundle" "$tmp/$bundle" || die "cannot read $local_dir/$bundle"
  else
    [ -z "$local_dir" ] || say "downloading $bundle from $base"
    fetch "${base}$bundle" "$tmp/$bundle"
  fi
  want=$(listed "$bundle")
  [ -n "$want" ] || die "SHA256SUMS does not list $bundle"
  [ "$(sha256 "$tmp/$bundle")" = "$want" ] || die "checksum MISMATCH for $bundle: refusing to install"
  say 'signature and checksum verified'

  # Paths stay inside the deploy directory: no absolute paths, no `..`, regular files and directories only.
  tar -tzf "$tmp/$bundle" > "$tmp/list" || die "cannot read $bundle"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$tmp/list"; then die "$bundle holds an unsafe path"; fi
  if tar -tvzf "$tmp/$bundle" | grep -Eqv '^[-d]'; then die "$bundle holds a link or a special file"; fi
  need_files='docker-compose.yml docker-compose.prod.yml ops/deploy/deploy.sh'
  [ "$with_proxy" = no ] || need_files="$need_files ops/proxy/Caddyfile"
  for f in $need_files; do
    grep -qx "\(\./\)\{0,1\}$f" "$tmp/list" || {
      [ "$f" != ops/proxy/Caddyfile ] || die "$bundle has no built-in HTTPS proxy (ops/proxy/Caddyfile): --with-proxy needs release 1.1.0 or later"
      die "$bundle has no $f"
    }
  done

  # 4. unpack.
  prepare_dir
  # The files belong to this user, with its umask: never the build machine's owners or modes.
  tar -xzf "$tmp/$bundle" -C "$dir" --no-same-owner --no-same-permissions || die "cannot unpack into $dir"
  if [ ! -e "$dir/.env" ]; then
    (umask 077 && : > "$dir/.env")
  fi
  chmod 600 "$dir/.env"

  if [ "$with_proxy" = yes ]; then
    mkdir -p "$dir/proxy/certs" "$dir/proxy/sites" || die "cannot create $dir/proxy"
    if [ "$cert_mode" = files ]; then
      # Caddy reads them as root inside the container; on the host only this user may read the key.
      (umask 077 && cp "$key" "$dir/proxy/certs/key.pem") || die "cannot copy $key"
      cp "$cert" "$dir/proxy/certs/cert.pem" || die "cannot copy $cert"
      chmod 600 "$dir/proxy/certs/key.pem"
      chmod 644 "$dir/proxy/certs/cert.pem"
    fi
    {
      printf '# The built-in HTTPS proxy (install.sh --with-proxy; docs/operations.md, section 4b).\n'
      printf 'COMPOSE_PROFILES=proxy\nYODA_PROXY_DOMAIN=%s\nYODA_PROXY_CERT_MODE=%s\n' "$domain" "$cert_mode"
      [ -z "$acme_email" ] || printf 'YODA_PROXY_ACME_EMAIL=%s\n' "$acme_email"
      [ "$acme_staging" = no ] || printf '# Let'"'"'s Encrypt staging (a trial: browsers do not trust it); remove for a real certificate.\nYODA_PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory\n'
      [ -z "$http_port" ] || printf 'YODA_PROXY_HTTP_PORT=%s\n' "$http_port"
      [ -z "$https_port" ] || printf 'YODA_PROXY_HTTPS_PORT=%s\n' "$https_port"
    } >> "$dir/.env"
    url="https://$domain"
    [ -z "$https_port" ] || [ "$https_port" = 443 ] || url="$url:$https_port"
    say "built-in HTTPS proxy: $url (certificates: $cert_mode), written to $dir/.env"
  fi

  # The image prefix: the option or env, else the bundle's (the registry the release was pushed to), else GHCR.
  if [ -z "$prefix" ] && [ -f "$dir/bundle.env" ]; then
    prefix=$(sed -n 's/^YODA_IMAGE_PREFIX=\([A-Za-z0-9._:/-]*\)$/\1/p' "$dir/bundle.env" | tail -n 1)
  fi
  [ -n "$prefix" ] || prefix=$DEFAULT_IMAGE_PREFIX
  # Pinned before the first deploy, so no compose command on this host can fall back to Docker Hub. release.env wins
  # over .env; deploy.sh keeps the prefix there on every later deploy.
  printf 'YODA_IMAGE_PREFIX=%s\n' "$prefix" > "$dir/release.env"
  pinned=''
  if grep -q '^YODA_[A-Z]*_DIGEST=' "$dir/bundle.env" 2>/dev/null; then
    if [ "${YODA_IGNORE_BUNDLE_DIGESTS:-}" = 1 ]; then
      pinned=', by tag (YODA_IGNORE_BUNDLE_DIGESTS=1)'
    else
      pinned=', pinned by the digests in the signed bundle.env'
    fi
  fi
  say "images: $prefix/<core|portal|runner|backup>:$version$pinned"

  # 5. registry login. The GHCR images are public: no login. A mirror's registry usually needs one.
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
    elif tty_ok; then
      say "log in to $registry with a read_registry deploy token (typed, not shown):"
      docker login "$registry" <"$tty" || die "docker login $registry failed"
    else
      say "warning: no saved login for $registry; if the pull fails, run: docker login $registry"
    fi
  fi

  # 6. deploy.
  say "deploying $version in $dir"
  cd "$dir"
  rc=0
  YODA_VERSION="$version" YODA_IMAGE_PREFIX="$prefix" sh ops/deploy/deploy.sh || rc=$?
  # deploy.sh exits 3 when it cannot pull. The ghcr.io images are public once the release owner made them so; until
  # then (or for a private fork) a GitHub token that may read packages logs in, asked for only now.
  if [ "$rc" -eq 3 ] && [ "${prefix%%/*}" = ghcr.io ] && [ "$login" = yes ] && tty_ok; then
    say 'pulling from ghcr.io failed. If the packages are not public, log in with a GitHub token that may read'
    say 'packages (read:packages; typed, not shown), or press Ctrl-C:'
    docker login ghcr.io <"$tty" || die 'docker login ghcr.io failed'
    rc=0
    YODA_VERSION="$version" YODA_IMAGE_PREFIX="$prefix" sh ops/deploy/deploy.sh || rc=$?
  fi
  [ "$rc" -eq 0 ] ||
    die "deploy of $version failed (images $prefix/<name>:$version; registry login: docker login ${prefix%%/*}? see docs/operations.md, Troubleshooting). Fix it, then: cd $dir && YODA_VERSION=$version sh ops/deploy/deploy.sh"

  cat <<EOF
install: Yoda $version is running in $dir.
  Commands there (docs/operations.md, section 4):
    alias dc='docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'
  Upgrade later: cd $dir && YODA_VERSION=<version> sh ops/deploy/deploy.sh (or an internal mirror's deploy job)
  Finish the setup wizard, and store the recovery kit it gives you off this host.
EOF
  if [ "$with_proxy" = yes ]; then
    echo "  Built-in HTTPS proxy: $url (docs/operations.md, section 4b; the name must lead to this host on the staff PCs)."
    [ "$cert_mode" != internal ] ||
      echo "  Install $dir/proxy/root.crt (the internal CA's public root, no key) on the staff PCs before they open it."
  fi
  if [ "$group_added" = yes ] || [ "$via_group" = yes ]; then
    echo "  $(id -un) is in the docker group now: log out and back in before running docker or dc yourself (until then: sg docker -c '<command>')."
  fi
}

# The only command at the top level, on the last line, in braces: a download cut short anywhere is incomplete
# shell and runs nothing (not even `main` without its arguments).
{ main "$@"; }
