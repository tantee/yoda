# Build context: ops/backup (docker build -t yoda-backup ops/backup)
# PostgreSQL 17 client tools (pg_dump/pg_restore must match the server major) and rclone for the S3 mirror.
FROM rclone/rclone:1.71.2 AS rclone

FROM postgres:17.12-bookworm
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY lib.sh backup.sh restore.sh healthcheck.sh /opt/backup/
# CA certificates for an https S3 endpoint.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN chmod 0755 /opt/backup/backup.sh /opt/backup/restore.sh /opt/backup/healthcheck.sh \
 && mkdir -p /backups && chown postgres:postgres /backups
ENV PATH=/opt/backup:$PATH \
    TZ=Asia/Bangkok \
    BACKUP_DIR=/backups
USER postgres
WORKDIR /backups
# Credentials (DATABASE_URL, S3_*) come from the environment at runtime.
# One-shot: `backup.sh --now`; restore: `RESTORE_CONFIRM=yes restore.sh <stamp>` (see restore.sh).
# Unhealthy once the last backup is older than BACKUP_MAX_AGE_HOURS (26); a fresh daemon gets that long too.
HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=1 CMD ["healthcheck.sh"]
ENTRYPOINT ["backup.sh"]
