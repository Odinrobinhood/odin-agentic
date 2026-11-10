#!/usr/bin/env bash
# Weekly restore test (architecture §9): restore the newest dump into a scratch database and compare
# row counts of key tables with the live database. Runs as postgres via odin-restore-test.timer.
# On failure an operator alert is queued (kept in alert_events and the notifier log).
set -uo pipefail
DIR=/var/backups/odin
DB=odin_restore_test
LATEST=$(ls -1t "$DIR"/odin-*.dump 2>/dev/null | head -1)

alert() {
  psql -qtAX -d odin -c "INSERT INTO alert_events (source, source_id, payload) VALUES ('system', '00000000-0000-0000-0000-000000000000', jsonb_build_object('event', 'ops_check_failed', 'operator', true, 'check', 'restore_test', 'error', \$\$$1\$\$))" >/dev/null || true
  echo "restore test FAILED: $1"
  exit 1
}

[ -n "$LATEST" ] || alert "no backup dump found in $DIR"
(cd "$DIR" && sha256sum -c --quiet "$(basename "$LATEST").sha256") || alert "checksum mismatch for $LATEST"

psql -qtAX -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null
psql -qtAX -d postgres -c "CREATE DATABASE $DB" >/dev/null || alert "cannot create $DB"
psql -qtAX -d "$DB" -c "CREATE EXTENSION timescaledb; SELECT timescaledb_pre_restore();" >/dev/null || alert "timescaledb pre-restore failed"
# expected noise ("already exists" for the extension's objects) is ignored; the row-count checks below decide
pg_restore -d "$DB" --no-owner "$LATEST" >"/tmp/odin-restore.log" 2>&1 || true
psql -qtAX -d "$DB" -c "SELECT timescaledb_post_restore();" >/dev/null || alert "timescaledb post-restore failed"

# the dump is a snapshot: restored counts may trail live ones, but never exceed them and never be empty when live is not
for t in users agents agent_configs agent_wallets decisions executions positions guards signer.signatures signer.wallet_bindings schema_migrations; do
  live=$(psql -qtAX -d odin -c "SELECT count(*) FROM $t")
  rest=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM $t" 2>/dev/null) || alert "table $t missing after restore"
  if [ "$rest" -gt "$live" ] || { [ "$live" -gt 0 ] && [ "$rest" -eq 0 ]; }; then alert "table $t: restored $rest rows vs live $live"; fi
done
psql -qtAX -d postgres -c "DROP DATABASE $DB" >/dev/null
echo "restore test ok: $(basename "$LATEST")"
