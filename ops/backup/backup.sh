#!/usr/bin/env bash
# Daily backups: a pg_dump -Fc of the database and an S3 mirror of the storage bucket, kept for
# BACKUP_KEEP_DAYS days in BACKUP_DIR.
#   backup.sh         loop: sleep until the next BACKUP_AT (HH:MM in TZ), back up, repeat
#   backup.sh --now   one backup, then exit
# Env: DATABASE_URL (or PG*), S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION,
#      BACKUP_DIR (/backups), BACKUP_KEEP_DAYS (14), BACKUP_AT (02:00), TZ (Asia/Bangkok).
# Writes pg-<YYYYMMDD-HHMM>.dump, storage-<YYYYMMDD-HHMM>/ and a `latest` marker holding the stamp.
# Exits non-zero when a backup fails (the container's restart policy brings the loop back).
set -euo pipefail
LOG_NAME=backup
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$here/lib.sh"

dir=${BACKUP_DIR:-/backups}
keep=${BACKUP_KEEP_DAYS:-14}
at=${BACKUP_AT:-02:00}

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

# One backup in a subshell that stops at the first failed step; half-written files are removed.
# (errexit is ignored inside `if`/`&&` conditions, so the status is taken with errexit off instead.)
run_backup() {
  local status
  set +e
  (
    set -e
    backup_once
  )
  status=$?
  set -e
  ((status == 0)) && return 0
  remove_partials || true
  log 'backup failed'
  return 1
}

# Seconds until the next BACKUP_AT in the local time zone (GNU date).
seconds_until_next() {
  local now target
  now=$(date +%s)
  target=$(date -d "today $at" +%s)
  if ((target <= now)); then target=$(date -d "tomorrow $at" +%s); fi
  echo $((target - now))
}

main() {
  [[ $at =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die 'BACKUP_AT must be HH:MM'
  [[ $keep =~ ^[1-9][0-9]*$ ]] || die 'BACKUP_KEEP_DAYS must be a positive integer'
  [[ -d $dir && -w $dir ]] || die "$dir is not a writable directory"
  setup_pg
  setup_store

  case ${1:-} in
    --now)
      run_backup
      ;;
    '')
      trap 'log "stopping"; exit 0' TERM INT
      while true; do
        local secs
        secs=$(seconds_until_next)
        log "next backup at $(date -d "@$(($(date +%s) + secs))" '+%Y-%m-%d %H:%M %Z') (keeping $keep days)"
        sleep "$secs" &
        wait $!
        run_backup
      done
      ;;
    *)
      die 'usage: backup.sh [--now]'
      ;;
  esac
}

main "$@"
