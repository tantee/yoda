#!/usr/bin/env bash
# Docker HEALTHCHECK of the backup daemon: unhealthy when the `latest` marker is older than
# BACKUP_MAX_AGE_HOURS (26), or when there is no backup yet and the daemon started longer ago than that.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$here/lib.sh"

dir=${BACKUP_DIR:-/backups}
hours=${BACKUP_MAX_AGE_HOURS:-26}
latest=
started=
if [[ -f $dir/latest ]]; then latest=$(stat -c %Y "$dir/latest"); fi
if [[ -f $STARTED_FILE ]]; then started=$(<"$STARTED_FILE"); fi
backup_health "$(date +%s)" "$latest" "$started" $((hours * 3600))
