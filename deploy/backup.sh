#!/usr/bin/env bash
# Daily Postgres backup (architecture §9). Runs as the postgres OS user via odin-backup.timer.
# Custom-format dump, kept 14 days. NOTE: copies stay on this host until an off-host target exists.
set -euo pipefail
DIR=/var/backups/odin
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/odin-$STAMP.dump"

umask 077
pg_dump -d odin -Fc -f "$OUT.partial"
mv "$OUT.partial" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
find "$DIR" -name 'odin-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
