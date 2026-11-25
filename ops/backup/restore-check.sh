#!/usr/bin/env bash
# DEV ONLY: end-to-end check of backup.sh and restore.sh against the running dev stack (`docker compose up -d`).
#   ops/backup/restore-check.sh       prints `restore ok` on success
# It works on a scratch database (yoda_restore_check) and a scratch bucket (yoda-restore-check) on the dev
# Postgres and RustFS, which it creates and removes; the dev `yoda` database and bucket are never touched.
#   1. Migrate the scratch database, add a known person row and two objects.
#   2. backup.sh --now (in the backup image, on the dev compose network).
#   3. Drop and recreate the database empty; delete the bucket.
#   4. RESTORE_CONFIRM=yes restore.sh latest.
#   5. Check the row and the objects, then start core on the restored data and call GET /ready.
# Needs docker and pnpm (with `pnpm install` done). RESTORE_CHECK_CORE=0 skips step 5's core start.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

db=yoda_restore_check
bucket=yoda-restore-check
image=yoda-backup:restore-check
volume=yoda-restore-check-backups-$$
core_port=${RESTORE_CHECK_CORE_PORT:-4917}
core_pid=
core_log=

say() { printf 'restore-check: %s\n' "$*"; }
fail() {
  printf 'restore-check: FAILED: %s\n' "$*" >&2
  exit 1
}

# A value from the environment, else from the root .env, else the dev default (compose does the same).
dev_value() {
  local name=$1 fallback=$2 line
  if [[ -n ${!name:-} ]]; then
    printf '%s' "${!name}"
    return
  fi
  if [[ -f .env ]] && line=$(grep -E "^${name}=" .env | tail -1); then
    line=${line#*=}
    line=${line%\"}
    line=${line#\"}
    printf '%s' "$line"
    return
  fi
  printf '%s' "$fallback"
}

pg_user=yoda                                                          # DEV ONLY (docker-compose.yml)
pg_password=yoda                                                      # DEV ONLY (docker-compose.yml)
pg_port=$(dev_value POSTGRES_PORT 5432)
s3_port=$(dev_value S3_PORT 9000)
S3_ACCESS_KEY=$(dev_value S3_ACCESS_KEY yoda)                         # DEV ONLY
S3_SECRET_KEY=$(dev_value S3_SECRET_KEY yoda-dev-rustfs)              # DEV ONLY
S3_BUCKET=$bucket
S3_ENDPOINT=http://rustfs:9000
DATABASE_URL=postgres://$pg_user:$pg_password@postgres:5432/$db       # DEV ONLY
export S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_ENDPOINT DATABASE_URL

pg_cid=$(docker compose ps -q postgres)
rustfs_cid=$(docker compose ps -q rustfs)
[[ -n $pg_cid && -n $rustfs_cid ]] || fail 'the dev stack is not running (docker compose up -d postgres rustfs)'
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$pg_cid" | awk '{print $1}')

psql_dev() {
  docker compose exec -T -e PGOPTIONS='-c client_min_messages=warning' postgres psql -v ON_ERROR_STOP=1 -X -q -At -U "$pg_user" "$@"
}

# Runs a command in the backup image on the dev network, with the scratch settings from the environment.
in_image() {
  docker run --rm -i --network "$network" -v "$volume:/backups" \
    -e DATABASE_URL -e S3_ENDPOINT -e S3_BUCKET -e S3_ACCESS_KEY -e S3_SECRET_KEY -e RESTORE_CONFIRM \
    "$@"
}

rclone_scratch() {
  in_image --entrypoint bash "$image" -c 'source /opt/backup/lib.sh; setup_store; rc "$@"' rc "$@"
}

drop_db() {
  psql_dev -d postgres -c "drop database if exists $db with (force)"
}

cleanup() {
  local status=$?
  if [[ -n $core_pid ]]; then
    kill "$core_pid" 2>/dev/null || true
    wait "$core_pid" 2>/dev/null || true
  fi
  [[ -z $core_log ]] || rm -f "$core_log"
  drop_db >/dev/null 2>&1 || true
  rclone_scratch purge "store:$bucket" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

say 'building the backup image'
docker build -q -t "$image" ops/backup >/dev/null
docker volume create "$volume" >/dev/null

say "creating scratch database $db and bucket $bucket"
drop_db
psql_dev -d postgres -c "create database $db"
DATABASE_URL=postgres://$pg_user:$pg_password@localhost:$pg_port/$db \
  pnpm --silent --filter @yoda/core db:migrate >/dev/null
token=restore-check-$(date +%s)-$RANDOM
psql_dev -d "$db" -c "insert into people (keycloak_sub, username, display_name) values ('restore-check', 'restore-check', '$token')"
migrations=$(psql_dev -d "$db" -c 'select count(*) from drizzle.__drizzle_migrations')
rclone_scratch purge "store:$bucket" >/dev/null 2>&1 || true
rclone_scratch mkdir "store:$bucket"
printf '%s' "$token" | rclone_scratch rcat "store:$bucket/attachments/check/hello.txt"
printf 'สวัสดี %s' "$token" | rclone_scratch rcat "store:$bucket/knowledge/ไฟล์ทดสอบ.txt"
say "known data: person $token, $migrations migrations, 2 objects"

say 'backup.sh --now'
in_image "$image" --now
stamp=$(in_image --entrypoint cat "$image" /backups/latest)
say "backup stamp $stamp"

say 'dropping the database and deleting the bucket'
drop_db
psql_dev -d postgres -c "create database $db"
rclone_scratch purge "store:$bucket"
[[ $(psql_dev -d "$db" -c "select count(*) from pg_tables where schemaname = 'public'") == 0 ]] || fail 'database not empty'
if rclone_scratch lsf "store:$bucket" >/dev/null 2>&1 && [[ -n $(rclone_scratch lsf -R "store:$bucket") ]]; then
  fail 'bucket not empty'
fi

say 'restore.sh without RESTORE_CONFIRM must refuse'
if RESTORE_CONFIRM='' in_image --entrypoint restore.sh "$image" latest >/dev/null 2>&1; then
  fail 'restore ran without RESTORE_CONFIRM=yes'
fi

say "RESTORE_CONFIRM=yes restore.sh latest"
RESTORE_CONFIRM=yes in_image --entrypoint restore.sh "$image" latest

say 'verifying'
got=$(psql_dev -d "$db" -c "select display_name from people where keycloak_sub = 'restore-check'")
[[ $got == "$token" ]] || fail "person row: expected $token, got '$got'"
[[ $(psql_dev -d "$db" -c 'select count(*) from drizzle.__drizzle_migrations') == "$migrations" ]] || fail 'migration count differs'
[[ $(rclone_scratch cat "store:$bucket/attachments/check/hello.txt") == "$token" ]] || fail 'object attachments/check/hello.txt'
[[ $(rclone_scratch cat "store:$bucket/knowledge/ไฟล์ทดสอบ.txt") == "สวัสดี $token" ]] || fail 'object knowledge/ไฟล์ทดสอบ.txt'
say 'row and objects restored'

if [[ ${RESTORE_CHECK_CORE:-1} != 0 ]]; then
  if curl -s -o /dev/null "http://127.0.0.1:$core_port/"; then
    fail "port $core_port is taken (set RESTORE_CHECK_CORE_PORT)"
  fi
  say "starting core on the restored data (port $core_port)"
  core_log=$(mktemp)
  (
    cd apps/core
    PORT=$core_port \
      DATABASE_URL=postgres://$pg_user:$pg_password@localhost:$pg_port/$db \
      S3_ENDPOINT=http://localhost:$s3_port \
      OIDC_ISSUER=http://localhost:8080/realms/yoda \
      OIDC_CLIENT_ID=yoda-portal \
      MIGRATE_ON_START=false \
      exec node --import tsx src/server.ts
  ) >"$core_log" 2>&1 &
  core_pid=$!
  ready=
  for _ in $(seq 1 60); do
    if ready=$(curl -fsS "http://127.0.0.1:$core_port/ready" 2>/dev/null); then break; fi
    kill -0 "$core_pid" 2>/dev/null || { tail -20 "$core_log" >&2; fail 'core exited'; }
    ready=
    sleep 1
  done
  [[ -n $ready ]] || { tail -20 "$core_log" >&2; fail 'core /ready did not answer 200 within 60s'; }
  say "core /ready: $ready"
fi

say 'restore ok'
