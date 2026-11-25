#!/usr/bin/env bash
# Restores one backup into the configured database and bucket, replacing what is there.
#   RESTORE_CONFIRM=yes restore.sh <YYYYMMDD-HHMM | latest>
# Env: DATABASE_URL (or PG*), S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, BACKUP_DIR.
# Stop core and portal first so nothing writes while the restore runs. pg_restore --clean drops and recreates
# the objects in the backup; tables that are not in it stay, so restoring into an empty database is the
# clean path (drop and recreate it first when the schema has moved on since the backup).
set -euo pipefail
LOG_NAME=restore
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$here/lib.sh"

if [[ ${RESTORE_CONFIRM:-} != yes ]]; then
  die 'refusing to run: this replaces the database and the bucket; set RESTORE_CONFIRM=yes to continue'
fi
[[ $# -eq 1 ]] || die 'usage: RESTORE_CONFIRM=yes restore.sh <YYYYMMDD-HHMM | latest>'

dir=${BACKUP_DIR:-/backups}
stamp=$1
if [[ $stamp == latest ]]; then
  [[ -f $dir/latest ]] || die "no latest marker in $dir"
  stamp=$(<"$dir/latest")
fi
[[ $stamp =~ $STAMP_RE ]] || die 'stamp must be YYYYMMDD-HHMM (see the pg-<stamp>.dump names in the backup directory) or latest'
dump=$dir/pg-$stamp.dump
storage=$dir/storage-$stamp
[[ -f $dump ]] || die "missing $dump"
[[ -d $storage ]] || die "missing $storage/"

setup_pg
setup_store

log "restoring database $PGDATABASE from pg-$stamp.dump"
pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error --no-password \
  --dbname "$PGDATABASE" "$dump" || die 'database restore failed (nothing was changed: it runs in one transaction)'
log 'database restored'

log "restoring bucket $S3_BUCKET from storage-$stamp/"
rc sync "$storage" "store:$S3_BUCKET" || die 'storage restore failed'
log "storage restored ($(find "$storage" -type f | wc -l | tr -d ' ') objects)"

log "restore of $stamp done. Next steps:"
log '  1. docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrate  (applies migrations newer than the backup)'
log '  2. docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d core portal'
log '  3. check that GET /ready on core answers 200, then sign in and spot-check recent work'
