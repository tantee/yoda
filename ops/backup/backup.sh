#!/usr/bin/env bash
# Daily backups: a pg_dump -Fc of the database and an S3 mirror of the storage bucket, kept for
# BACKUP_KEEP_DAYS days in BACKUP_DIR.
#   backup.sh         loop: sleep until the next backup time (HH:MM in TZ), back up, repeat; a failed run is
#                     retried BACKUP_RETRIES (3) times, BACKUP_RETRY_DELAY (900) seconds apart, before it
#                     waits for the next day
#   backup.sh --now   one backup, then exit (non-zero on failure)
# The backup time and days kept come from BACKUP_AT / BACKUP_KEEP_DAYS when set (env wins), else from System
# settings → Backups (the settings table, re-read every BACKUP_POLL_SECONDS (60) while waiting, so a change
# applies within a minute), else 02:00 and 14.
# Env: DATABASE_URL (or PG*), S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION (DATABASE_URL and
#      the S3 keys default to YODA_BOOTSTRAP_FILE's, the bootstrap volume),
#      BACKUP_DIR (/backups), BACKUP_KEEP_DAYS, BACKUP_AT, TZ (Asia/Bangkok).
# Writes pg-<YYYYMMDD-HHMM>.dump, storage-<YYYYMMDD-HHMM>/ and a `latest` marker holding the stamp.
# Only one backup or restore runs at a time (flock on BACKUP_DIR/.lock); a second one exits non-zero.
# healthcheck.sh turns unhealthy when `latest` is older than BACKUP_MAX_AGE_HOURS (26).
set -euo pipefail
LOG_NAME=backup
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$here/lib.sh"

dir=${BACKUP_DIR:-/backups}
# Set in env, these win over System settings.
env_at=${BACKUP_AT:-}
env_keep=${BACKUP_KEEP_DAYS:-}
keep=${env_keep:-14}
at=${env_at:-02:00}
poll=${BACKUP_POLL_SECONDS:-60}
settings_warned=
retries=${BACKUP_RETRIES:-3}
retry_delay=${BACKUP_RETRY_DELAY:-900}

remove_partials() {
  find "$dir" -mindepth 1 -maxdepth 1 -name '*.partial' -exec rm -rf {} +
}

backup_once() {
  local stamp dump storage objects n name
  stamp=$(date +%Y%m%d-%H%M)
  dump=$dir/pg-$stamp.dump
  storage=$dir/storage-$stamp
  [[ ! -e $dump && ! -e $storage ]] || die "backup $stamp already exists"
  remove_partials

  # Both parts are written as *.partial and renamed only once both succeeded: a failed run leaves nothing.
  log "dumping database $PGDATABASE to pg-$stamp.dump"
  pg_dump --format=custom --no-password --file "$dump.partial" "$PGDATABASE"
  log "database dumped ($(du -h "$dump.partial" | cut -f1))"

  log "mirroring bucket $S3_BUCKET to storage-$stamp/"
  mkdir -p "$storage.partial"
  rc sync "store:$S3_BUCKET" "$storage.partial"
  objects=$(find "$storage.partial" -type f | wc -l | tr -d ' ')
  log "storage mirrored ($objects objects)"

  mv "$dump.partial" "$dump"
  mv "$storage.partial" "$storage"
  printf '%s\n' "$stamp" >"$dir/latest.partial"
  mv "$dir/latest.partial" "$dir/latest"
  log "latest is $stamp"

  n=0
  while IFS= read -r name; do
    rm -rf "${dir:?}/$name"
    n=$((n + 1))
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | select_expired "$keep" "$(date +%Y%m%d)")
  log "removed $n backup files older than $keep days"
}

# One backup in a subshell holding the lock, stopping at the first failed step; its half-written files are
# removed on the way out. A second run finds the lock taken and leaves the first one's files alone.
# (errexit is ignored inside `if`/`&&` conditions, so the status is taken with errexit off instead.)
run_backup() {
  local status errexit=
  [[ $- == *e* ]] && errexit=1
  set +e
  (
    set -e
    take_lock "$dir"
    trap remove_partials EXIT
    backup_once
  )
  status=$?
  [[ -z $errexit ]] || set -e
  ((status == 0)) && return 0
  log 'backup failed'
  return "$status"
}

# The scheduled run: the backup, retried with a delay before giving up until the next BACKUP_AT.
# Never call it (or run_backup) as a condition: bash would ignore errexit inside the backup.
scheduled_run() {
  local status errexit=
  [[ $- == *e* ]] && errexit=1
  set +e
  with_retries "$retries" "$retry_delay" run_backup
  status=$?
  [[ -z $errexit ]] || set -e
  ((status == 0)) && return 0
  log "backup failed $((retries + 1)) times; next try at the next BACKUP_AT"
  return "$status"
}

# Re-reads the backup time and days kept (env > System settings > the current values). When the database cannot be
# read (not migrated yet, restarting), keeps the current values and says so once until it can be read again.
refresh_settings() {
  local rows picked new_at new_keep
  if [[ -n $env_at && -n $env_keep ]]; then
    rows=''
  elif ! rows=$(db_backup_settings); then
    [[ -n $settings_warned ]] || log "cannot read the backup settings from the database; keeping $at, $keep days"
    settings_warned=1
    return 0
  fi
  settings_warned=
  picked=$(pick_backup_settings "$env_at" "$env_keep" "$at" "$keep" <<<"$rows")
  new_at=${picked% *}
  new_keep=${picked#* }
  if [[ $new_at != "$at" || $new_keep != "$keep" ]]; then
    log "backup settings: daily at $new_at, keeping $new_keep days"
  fi
  at=$new_at
  keep=$new_keep
}

# Epoch of the next BACKUP_AT in the local time zone (GNU date), never within 60 s of the last run's start.
next_target() {
  pick_target "$(date +%s)" "$(date -d "today $at" +%s)" "$(date -d "tomorrow $at" +%s)" "$1"
}

# Sleeps <seconds> in the background, so the TERM trap runs at once.
sleep_for() {
  sleep "$1" &
  wait $!
}

main() {
  [[ $at =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die 'BACKUP_AT must be HH:MM'
  [[ $keep =~ ^[1-9][0-9]*$ ]] || die 'BACKUP_KEEP_DAYS must be a positive integer'
  [[ $poll =~ ^[1-9][0-9]*$ ]] || die 'BACKUP_POLL_SECONDS must be a positive whole number'
  [[ $retries =~ ^[0-9]+$ ]] || die 'BACKUP_RETRIES must be a whole number'
  [[ $retry_delay =~ ^[0-9]+$ ]] || die 'BACKUP_RETRY_DELAY must be a whole number of seconds'
  [[ -d $dir && -w $dir ]] || die "$dir is not a writable directory"
  setup_pg
  setup_store
  refresh_settings

  case ${1:-} in
    --now)
      run_backup
      ;;
    '')
      trap 'log "stopping"; exit 0' TERM INT
      # The healthcheck's grace period before the first backup starts here.
      [[ -e $STARTED_FILE ]] || date +%s >"$STARTED_FILE"
      local last=0 target='' target_at='' now
      while true; do
        # The target moves only when the backup time changes; it is never recomputed after it has passed.
        if [[ -z $target || $at != "$target_at" ]]; then
          target=$(next_target "$last")
          target_at=$at
          log "next backup at $(date -d "@$target" '+%Y-%m-%d %H:%M %Z') (keeping $keep days)"
        fi
        now=$(date +%s)
        if ((now < target)); then
          sleep_for $((target - now < poll ? target - now : poll))
          refresh_settings
          continue
        fi
        last=$now
        target=''
        set +e
        scheduled_run
        set -e
        refresh_settings
      done
      ;;
    *)
      die 'usage: backup.sh [--now]'
      ;;
  esac
}

# Sourcing (the tests) only defines the functions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
