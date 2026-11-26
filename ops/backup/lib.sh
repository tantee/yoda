# shellcheck shell=bash
# Shared helpers for backup.sh and restore.sh. The pure functions (retention, URL parsing) are tested in
# apps/core/test/ops-backup.test.ts; keep them bash 3.2 compatible (macOS runs the tests).
# Never print credentials: no `set -x`, no echoing DATABASE_URL or S3 keys.

# shellcheck disable=SC2034 # used by restore.sh
STAMP_RE='^[0-9]{8}-[0-9]{4}$'

# Written by the backup daemon when it starts: the healthcheck's grace period before the first backup.
# shellcheck disable=SC2034 # used by backup.sh and healthcheck.sh
STARTED_FILE=${BACKUP_STARTED_FILE:-/tmp/backup-started}

log() {
  printf '%s %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${LOG_NAME:-backup}" "$*"
}

die() {
  printf '%s: %s\n' "${LOG_NAME:-backup}" "$*" >&2
  exit 1
}

# Days since 1970-01-01 for a civil date (proleptic Gregorian; Howard Hinnant's days_from_civil).
days_from_civil() {
  local y=$((10#$1)) m=$((10#$2)) d=$((10#$3)) era yoe doy doe mp
  if ((m <= 2)); then y=$((y - 1)); fi
  if ((y >= 0)); then era=$((y / 400)); else era=$(((y - 399) / 400)); fi
  yoe=$((y - era * 400))
  if ((m > 2)); then mp=$((m - 3)); else mp=$((m + 9)); fi
  doy=$(((153 * mp + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

# Reads backup names (one per line) on stdin and prints those older than <keep_days> days relative to
# <today> (YYYYMMDD), in input order. Only `pg-<stamp>.dump` and `storage-<stamp>` are ever selected; the
# backup from exactly <keep_days> days ago is kept.
select_expired() {
  local keep=${1:-} today=${2:-} name day cutoff
  local re='^(pg-([0-9]{8})-[0-9]{4}\.dump|storage-([0-9]{8})-[0-9]{4})$'
  [[ $keep =~ ^[1-9][0-9]*$ ]] || { echo 'select_expired: keep days must be a positive integer' >&2; return 1; }
  [[ $today =~ ^[0-9]{8}$ ]] || { echo 'select_expired: today must be YYYYMMDD' >&2; return 1; }
  cutoff=$(($(days_from_civil "${today:0:4}" "${today:4:2}" "${today:6:2}") - keep))
  while IFS= read -r name || [[ -n $name ]]; do
    [[ $name =~ $re ]] || continue
    day=${BASH_REMATCH[2]}${BASH_REMATCH[3]}
    if (($(days_from_civil "${day:0:4}" "${day:4:2}" "${day:6:2}") < cutoff)); then
      printf '%s\n' "$name"
    fi
  done
}

# Picks the next run: today's BACKUP_AT if it is still ahead and more than 60 s after the last run's start
# (a clock that steps back must not run the same backup twice), else tomorrow's. All arguments are epochs.
pick_target() {
  local now=$1 today=$2 tomorrow=$3 last=${4:-0}
  if ((today > now && today > last + 60)); then echo "$today"; else echo "$tomorrow"; fi
}

# Runs `cmd...`; when it fails, retries up to <retries> times, sleeping <delay> seconds before each retry.
# The command never runs as a condition (`until cmd`, `cmd ||`), where bash would ignore errexit inside it.
with_retries() {
  local retries=$1 delay=$2 attempt=0 status errexit=
  shift 2
  [[ $- == *e* ]] && errexit=1
  while true; do
    set +e
    "$@"
    status=$?
    [[ -z $errexit ]] || set -e
    ((status == 0)) && return 0
    attempt=$((attempt + 1))
    ((attempt <= retries)) || return "$status"
    log "retrying in ${delay}s (retry $attempt of $retries)"
    sleep "$delay" &
    wait $!
  done
}

# Health of the backups: ok when `latest` is at most <max_age> seconds old, or, before the first backup,
# when the daemon started at most <max_age> seconds ago. Arguments are epochs ('' when missing).
backup_health() {
  local now=$1 latest=${2:-} started=${3:-} max=$4
  if [[ -n $latest ]]; then
    if ((now - latest <= max)); then
      echo "ok: last backup $(((now - latest) / 3600))h ago"
      return 0
    fi
    echo "stale: last backup $(((now - latest) / 3600))h ago"
    return 1
  fi
  if [[ -n $started ]] && ((now - started <= max)); then
    echo 'ok: no backup yet'
    return 0
  fi
  echo 'unhealthy: no backup'
  return 1
}

# Holds an exclusive lock on <dir>/.lock on fd 9 until the shell exits; fails at once when it is taken.
take_lock() {
  command -v flock >/dev/null || die 'flock is required'
  exec 9>"$1/.lock"
  flock -n 9 || {
    printf '%s: another backup or restore is running (%s/.lock is held)\n' "${LOG_NAME:-backup}" "$1" >&2
    exit 75
  }
}

# Decodes %XX escapes (a literal backslash stays a backslash).
url_decode() {
  local s=${1//\\/\\\\}
  printf '%b' "${s//%/\\x}"
}

# Exports PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (and PGSSLMODE) from a postgres:// URL, so the
# password never appears on a command line. Fails without echoing the URL.
pg_env_from_url() {
  local re='^postgres(ql)?://([^:@/]+)(:([^@/]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)(\?(.*))?$'
  local query
  [[ ${1:-} =~ $re ]] || { echo 'DATABASE_URL is not a postgres://user:password@host[:port]/db URL' >&2; return 1; }
  PGUSER=$(url_decode "${BASH_REMATCH[2]}")
  PGPASSWORD=$(url_decode "${BASH_REMATCH[4]}")
  PGHOST=${BASH_REMATCH[5]}
  PGPORT=${BASH_REMATCH[7]:-5432}
  PGDATABASE=$(url_decode "${BASH_REMATCH[8]}")
  query=${BASH_REMATCH[10]}
  if [[ $query =~ (^|&)sslmode=([a-z-]+) ]]; then
    PGSSLMODE=${BASH_REMATCH[2]}
    export PGSSLMODE
  fi
  export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
}

# Fills DATABASE_URL, S3_ACCESS_KEY and S3_SECRET_KEY from YODA_BOOTSTRAP_FILE (the bootstrap volume's
# bootstrap.env, written by the `init` service) when they are unset or empty; a value set in env wins. The file is
# read as KEY=value lines, never sourced, and only those three keys are taken. Prints no value.
load_bootstrap_file() {
  local file=${YODA_BOOTSTRAP_FILE:-} line key value
  [[ -n $file ]] || return 0
  [[ -z ${DATABASE_URL:-} || -z ${S3_ACCESS_KEY:-} || -z ${S3_SECRET_KEY:-} ]] || return 0
  [[ -r $file ]] || die "YODA_BOOTSTRAP_FILE: cannot read $file (did the init service run?)"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^(DATABASE_URL|S3_ACCESS_KEY|S3_SECRET_KEY)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ -z ${!key:-} && -n $value ]]; then
      printf -v "$key" '%s' "$value"
      export "${key?}"
    fi
  done <"$file"
}

# Database connection from DATABASE_URL, unless libpq's PG* variables are already set.
setup_pg() {
  load_bootstrap_file
  if [[ -z ${PGHOST:-} ]]; then
    [[ -n ${DATABASE_URL:-} ]] || die 'DATABASE_URL (or PGHOST, PGUSER, PGPASSWORD, PGDATABASE) is required'
    pg_env_from_url "$DATABASE_URL" || exit 1
  fi
  [[ -n ${PGDATABASE:-} ]] || die 'PGDATABASE is required'
}

# The S3 store as rclone remote `store:`, configured only through environment variables.
setup_store() {
  local v
  load_bootstrap_file
  for v in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do
    [[ -n ${!v:-} ]] || die "$v is required"
  done
  export RCLONE_CONFIG_STORE_TYPE=s3
  export RCLONE_CONFIG_STORE_PROVIDER=Other
  export RCLONE_CONFIG_STORE_ENDPOINT=$S3_ENDPOINT
  export RCLONE_CONFIG_STORE_REGION=${S3_REGION:-us-east-1}
  export RCLONE_CONFIG_STORE_ACCESS_KEY_ID=$S3_ACCESS_KEY
  export RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=$S3_SECRET_KEY
  export RCLONE_CONFIG_STORE_FORCE_PATH_STYLE=true
  # No config file: everything above comes from the environment.
  export RCLONE_CONFIG=/dev/null
}

# rclone with quiet output (errors only) and no progress stats.
rc() {
  rclone --log-level ERROR --stats 0 "$@"
}
