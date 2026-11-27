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
#    plus the image digests, YODA_<NAME>_DIGEST, when the bundle.env next to it is the same release's: the signed
#    bundle's pins, whatever the prefix; YODA_IGNORE_BUNDLE_DIGESTS=1 runs the tags instead), so every later
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
# The optional built-in HTTPS proxy (docs/operations.md, section 4b) is on when the compose profiles in effect
# (COMPOSE_PROFILES in .env, as `install.sh --with-proxy` writes it) run the `proxy` service; a profile `proxy` the
# release's compose files do not have (a release before the proxy) stops it (exit 2). It pins YODA_PROXY_ENABLED in
# release.env every time, `true` with the proxy and empty without (compose gives core and the portal
# YODA_TRUSTED_PROXY_HOPS=2 only for `true`, unless .env sets the hops), and refuses another value in .env or its
# environment (exit 2). With the proxy it also, before pulling, refuses a portal or core published on another
# address than loopback (anyone reaching the portal directly could then choose their own client address) and
# settings the proxy cannot run with (the domain, the mode, the ports, ACME's email and ports; exit 2), warns about
# hops other than 2 and an organisation certificate (files mode) that does not name the domain or expires within 30
# days; checks the Caddyfile and certificates with `caddy validate` before release.env or any running container is
# replaced (exit 2); after the start reloads the proxy's configuration (`caddy reload --force` of
# /etc/caddy/yoda/Caddyfile, the mounted ops/proxy directory, so the unpacked bundle's new Caddyfile, a changed
# proxy/sites file or certificate file applies even when compose kept the container); and copies the
# public root certificate of Caddy's internal CA to proxy/root.crt (internal mode; never a private key).
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
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 | sed \
    -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\\([^']*\\)'.*\$/\\1/" -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//'
}
legacy=$(env_value YODA_IMAGE_PREFIX)
case "$legacy" in
  '' | -* | *[!A-Za-z0-9._:/-]*) legacy='' ;;
esac
# The public release images (docs/releasing.md); a mirror passes or pins its own prefix.
DEFAULT_IMAGE_PREFIX='ghcr.io/tantee/yoda'
if [ -z "$prefix" ] && [ -z "$legacy" ]; then
  prefix=$DEFAULT_IMAGE_PREFIX
  echo "deploy: YODA_IMAGE_PREFIX is not set: using the public release images, $prefix (pinned in release.env)"
fi

# The signed bundle's image digests (bundle.env, unpacked with the compose files), for its own release only.
# Digests name content, not a registry: a mirror that copied the images serves the same ones, and a registry that
# rebuilt them fails the pull (closed) unless YODA_IGNORE_BUNDLE_DIGESTS=1 says to run its tags. A deploy of
# another version runs the tags: the variables are then pinned empty (compose before v2.25 warns about unset ones).
pins='YODA_CORE_DIGEST=
YODA_PORTAL_DIGEST=
YODA_RUNNER_DIGEST=
YODA_BACKUP_DIGEST=
'
if [ -f bundle.env ]; then
  bversion=$(sed -n 's/^YODA_VERSION=\([A-Za-z0-9._-]*\)$/\1/p' bundle.env | tail -n 1)
  if [ "$bversion" = "$YODA_VERSION" ] && grep -q '^YODA_[A-Z]*_DIGEST=' bundle.env; then
    if [ "${YODA_IGNORE_BUNDLE_DIGESTS:-}" = 1 ]; then
      echo "deploy: warning: YODA_IGNORE_BUNDLE_DIGESTS=1: running the $YODA_VERSION tags, not the digests the signed bundle pins" >&2
    else
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

# A setting as compose sees it: the environment wins over .env (set but empty included).
setting() {
  if eval "[ -n \"\${$1+x}\" ]"; then
    eval "printf '%s\n' \"\${$1}\""
  else
    env_value "$1"
  fi
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
refuse() {
  echo "deploy: $1" >&2
  rm -f "$release"
  exit 2
}

# The built-in proxy: on when the profiles in effect run its service (compose reads COMPOSE_PROFILES from .env).
proxy=no
# A compose error is not "no proxy service": stop with compose's own message.
services=$(dc config --services 2>&1) || {
  printf '%s\n' "$services" | tail -n 5 >&2
  refuse "docker compose cannot read the compose files and .env (the lines above); nothing was changed"
}
if printf '%s\n' "$services" | grep -qx proxy; then
  proxy=yes
else
  profiles=$(setting COMPOSE_PROFILES | tr -d '[:space:]')
  case ",$profiles," in
    *,proxy,*)
      refuse "COMPOSE_PROFILES names the built-in HTTPS proxy (proxy), but the compose files of $YODA_VERSION have no proxy service: it came with release 1.1.0. Deploy 1.1.0 or later (unpack its bundle first), or remove proxy from COMPOSE_PROFILES in .env (docs/operations.md, section 4b)"
      ;;
  esac
fi
# Pinned every time, so release.env (read after .env) decides; only the environment could still override it.
enabled=''
[ "$proxy" = no ] || enabled=true
for where in environment .env; do
  if [ "$where" = environment ]; then
    [ -n "${YODA_PROXY_ENABLED+x}" ] || continue
    value=$YODA_PROXY_ENABLED
  else
    value=$(env_value YODA_PROXY_ENABLED)
    [ -n "$value" ] || continue
  fi
  [ "$value" = "$enabled" ] ||
    refuse "YODA_PROXY_ENABLED=$value in the $where, but the built-in HTTPS proxy is $([ "$proxy" = yes ] && echo on || echo off): deploy.sh sets it in release.env itself; remove it (the proxy is on or off with COMPOSE_PROFILES; docs/operations.md, section 4b)"
done
printf 'YODA_PROXY_ENABLED=%s\n' "$enabled" >> "$release"

if [ "$proxy" = yes ]; then
  # With it, core and the portal believe one more X-Forwarded-For entry: the portal must be reachable only through
  # the proxy (and core only from this host), or a client could choose its own address and host.
  for name in PORTAL_BIND CORE_BIND; do
    bind=$(setting "$name")
    case "$bind" in
      '' | 127.* | localhost | ::1 | '[::1]') ;;
      *) refuse "$name=$bind publishes it beyond this host while the built-in HTTPS proxy is on: remove it from .env (the proxy reaches the portal inside compose; docs/operations.md, section 4b)" ;;
    esac
  done
  hops=$(setting YODA_TRUSTED_PROXY_HOPS)
  [ -z "$hops" ] || [ "$hops" = 2 ] ||
    echo "deploy: warning: YODA_TRUSTED_PROXY_HOPS=$hops while the built-in HTTPS proxy is on (it needs 2, which it sets when the line is not there): remove it from .env unless another proxy stands in front of this one (docs/operations.md, section 4b)" >&2
  # The settings the proxy runs with, as install.sh checks them: before pulling, with a message naming the line.
  pdomain=$(setting YODA_PROXY_DOMAIN)
  [ -n "$pdomain" ] || refuse 'the built-in HTTPS proxy is on but YODA_PROXY_DOMAIN is not set in .env (the name staff open, e.g. portal.example.org; docs/operations.md, section 4b)'
  printf '%s\n' "$pdomain" | grep -Eqx '([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?' ||
    refuse "YODA_PROXY_DOMAIN must be one host name such as portal.example.org (no scheme, port, path or wildcard): $pdomain"
  pmode=$(setting YODA_PROXY_CERT_MODE)
  pmode=${pmode:-internal}
  case "$pmode" in
    internal | files | acme) ;;
    *) refuse "YODA_PROXY_CERT_MODE must be internal, files or acme: $pmode" ;;
  esac
  for name in YODA_PROXY_HTTP_PORT YODA_PROXY_HTTPS_PORT; do
    port=$(setting "$name")
    case "$port" in
      '') ;;
      *[!0-9]* | 0*) refuse "$name is not a port number: $port" ;;
      *) [ "$port" -le 65535 ] || refuse "$name is not a port number: $port" ;;
    esac
  done
  if [ "$pmode" = acme ]; then
    case "$(setting YODA_PROXY_HTTP_PORT):$(setting YODA_PROXY_HTTPS_PORT)" in
      :443 | 80:443 | : | 80:) ;;
      *) refuse 'YODA_PROXY_CERT_MODE=acme needs the proxy on ports 80 and 443 (Let'"'"'s Encrypt checks the name there): remove YODA_PROXY_HTTP_PORT and YODA_PROXY_HTTPS_PORT from .env, or use internal or files' ;;
    esac
    pemail=$(setting YODA_PROXY_ACME_EMAIL)
    [ -n "$pemail" ] || refuse 'YODA_PROXY_CERT_MODE=acme needs YODA_PROXY_ACME_EMAIL in .env (the address Let'"'"'s Encrypt writes to)'
    printf '%s\n' "$pemail" | grep -Eqx '[^[:space:]{}@]+@[^[:space:]{}@]+\.[^[:space:]{}@]+' ||
      refuse "YODA_PROXY_ACME_EMAIL is not an email address (no spaces or braces): $pemail"
    pca=$(setting YODA_PROXY_ACME_CA)
    [ -z "$pca" ] || printf '%s\n' "$pca" | grep -Eqx 'https://[^[:space:]{}]+' ||
      refuse "YODA_PROXY_ACME_CA must be an https:// ACME directory URL (no spaces or braces), or not set for Let's Encrypt: $pca"
  fi
  mkdir -p proxy/certs proxy/sites
  # The organisation's certificate, when openssl is here: the name and the time left (caddy validate checks the key).
  if [ "$pmode" = files ] && [ -f proxy/certs/cert.pem ] && openssl version >/dev/null 2>&1; then
    if ! openssl x509 -in proxy/certs/cert.pem -noout -checkend 0 >/dev/null 2>&1; then
      echo "deploy: warning: proxy/certs/cert.pem has expired: browsers refuse the portal until you put the renewed certificate in place (docs/operations.md, section 4b)" >&2
    elif ! openssl x509 -in proxy/certs/cert.pem -noout -checkend 2592000 >/dev/null 2>&1; then
      echo "deploy: warning: proxy/certs/cert.pem expires within 30 days ($(openssl x509 -in proxy/certs/cert.pem -noout -enddate 2>/dev/null | sed 's/^notAfter=//')): put the renewed certificate in place before then" >&2
    fi
    cert_names_host proxy/certs/cert.pem "$pdomain" ||
      echo "deploy: warning: proxy/certs/cert.pem does not name $pdomain in its subject alternative names: browsers will refuse it for that name" >&2
  fi
fi

echo "deploy: $YODA_VERSION"
pull_failed() {
  echo "deploy: $1 (registry login on this host? the release $YODA_VERSION published? for ghcr.io packages that are not public: docker login ghcr.io with a GitHub token that may read packages; a mirror that rebuilt the images has other digests than the signed bundle: YODA_IGNORE_BUNDLE_DIGESTS=1 runs its tags)" >&2
  exit 3
}
dc pull --quiet || pull_failed "pulling the images of $YODA_VERSION failed"
# `pull` only warns when an image that could be built is missing; never fall back to building on the host.
for image in $(dc config --images); do
  docker image inspect "$image" >/dev/null 2>&1 || pull_failed "image $image is missing"
done
# The proxy's settings, before release.env or any running container is replaced: a wrong domain, mode or
# certificate fails here (with the new release's files and images).
if [ "$proxy" = yes ]; then
  out=$(dc run --rm --no-deps -T proxy caddy validate --config /etc/caddy/yoda/Caddyfile --adapter caddyfile 2>&1) || {
    printf '%s\n' "$out" | tail -n 3 >&2
    rm -f "$release"
    echo "deploy: the built-in HTTPS proxy's settings are invalid: check YODA_PROXY_DOMAIN, YODA_PROXY_CERT_MODE (internal, files or acme), YODA_PROXY_ACME_EMAIL (acme) or proxy/certs/cert.pem and key.pem (files) in .env and $(pwd)/proxy, and the *.caddy files in proxy/sites (docs/operations.md, section 4b); release.env and the running containers are unchanged" >&2
    exit 2
  }
  echo "deploy: built-in HTTPS proxy settings checked (caddy validate)"
fi
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

# The proxy's public address, and in internal mode the public root certificate of its CA for the staff PCs.
public=''
if [ "$proxy" = yes ]; then
  # Compose recreates the proxy only when its own settings change, not when the Caddyfile, a proxy/sites file or a
  # certificate file does: reload them now (validated above; Caddy keeps the running configuration on an error).
  tries=0
  until out=$(dc exec -T proxy caddy reload --config /etc/caddy/yoda/Caddyfile --adapter caddyfile --force 2>&1); do
    tries=$((tries + 1))
    if [ "$tries" -ge 6 ]; then
      printf '%s\n' "$out" | tail -n 3 >&2
      echo "deploy: the built-in HTTPS proxy did not reload its configuration: it may be stopped or restarting (dc ps proxy, dc logs --tail 50 proxy), or still run the previous configuration (then dc restart proxy; docs/operations.md, section 4b)" >&2
      exit 1
    fi
    sleep 5
  done
  echo "deploy: built-in HTTPS proxy configuration reloaded"
  # shellcheck disable=SC2016 # expanded inside the proxy container
  info=$(dc exec -T proxy sh -c 'printf "%s %s %s\n" "${YODA_PROXY_CERT_MODE:-}" "${YODA_PROXY_DOMAIN:-}" "${YODA_PROXY_HTTPS_PORT:-443}"' 2>/dev/null || true)
  # shellcheck disable=SC2086 # three plain words
  set -- $info
  mode=${1:-}
  if [ -n "${2:-}" ]; then
    public="https://$2"
    [ "${3:-443}" = 443 ] || public="$public:$3"
    echo "deploy: built-in HTTPS proxy on: $public (certificates: ${mode:-unknown})"
  fi
  if [ "$mode" = internal ]; then
    tries=0
    until dc cp proxy:/data/caddy/pki/authorities/local/root.crt proxy/root.crt.next >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -ge 6 ]; then
        echo "deploy: warning: the proxy's internal CA root is not there yet; copy it later with: dc cp proxy:/data/caddy/pki/authorities/local/root.crt proxy/root.crt" >&2
        break
      fi
      sleep 5
    done
    if [ -f proxy/root.crt.next ]; then
      chmod 644 proxy/root.crt.next
      mv proxy/root.crt.next proxy/root.crt
      echo "deploy: the internal CA's root certificate (public, no key) is $(pwd)/proxy/root.crt: install it on the staff PCs (docs/operations.md, section 4b)"
    fi
  fi
fi

# Setup state only (public, no secrets); an older core without /public-config prints nothing.
setup=$(dc exec -T core node -e "fetch('http://127.0.0.1:4000/public-config').then((r) => r.json()).then((c) => console.log(c.setup === 'required' ? 'required' : 'done'), () => console.log('unknown'))" 2>/dev/null || true)
if [ "$setup" = required ]; then
  port=$(sed -n 's/^PORTAL_PORT=\([0-9][0-9]*\)$/\1/p' .env | tail -n 1)
  if [ -n "$public" ]; then
    echo "deploy: setup is not finished. Open the setup wizard through the built-in proxy: $public/setup"
    echo "  Or, on this host or through an SSH tunnel:"
  else
    echo 'deploy: setup is not finished. Open the setup wizard:'
  fi
  cat <<EOF
  http://127.0.0.1:${port:-3000}/setup   (through your reverse proxy: https://<public host>/setup)
  From another machine: ssh -L ${port:-3000}:127.0.0.1:${port:-3000} <this host>, then open the address above.
Get the setup token (this output never shows it), in $(pwd):
  docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml exec core yoda-admin setup-token
It is also in core's log, in the "Yoda setup" banner (same command with: logs core).
EOF
fi
