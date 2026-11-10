#!/usr/bin/env bash
# Load test of the scheduler + Agent Runtime against a scratch database (odin_load). Run as root on staging.
#   deploy/load-test.sh [agents] [seconds] [workers] [concurrency] [llm_ms]
# Copies tokens, routes and recent market snapshots from the live DB; everything else is created fresh.
# Paper mode with a scripted model: nothing is signed or broadcast, the live DB is not written.
set -euo pipefail
APP=/opt/odin/app
AGENTS=${1:-300}; SECONDS_=${2:-600}; WORKERS=${3:-1}; CONC=${4:-8}; LLM_MS=${5:-6000}
psql_su() { sudo -u postgres psql -qtAX "$@"; }

psql_su -c "DROP DATABASE IF EXISTS odin_load" >/dev/null
psql_su -c "CREATE DATABASE odin_load OWNER odin" >/dev/null
psql_su -d odin_load -c "CREATE EXTENSION timescaledb; CREATE EXTENSION pgcrypto;" >/dev/null 2>&1
sudo -u odin env DATABASE_URL='postgresql://odin@/odin_load?host=/var/run/postgresql' node "$APP/packages/db/src/migrate.ts" | tail -1
for q in "tokens|SELECT * FROM tokens" "routes|SELECT * FROM routes" "market_snapshots|SELECT * FROM market_snapshots WHERE ts > now() - interval '3 hours'"; do
  t=${q%%|*}; sel=${q#*|}
  psql_su -d odin -c "COPY ($sel) TO STDOUT" | psql_su -d odin_load -c "COPY $t FROM STDIN"
done
echo "copied: $(psql_su -d odin_load -c "SELECT (SELECT count(*) FROM tokens) || ' tokens, ' || (SELECT count(*) FROM routes) || ' routes, ' || (SELECT count(*) FROM market_snapshots) || ' snapshots'")"
# assets: WETH plus the deepest routed Stock Tokens (realistic mix of one- and two-hop quotes)
ASSETS=$(psql_su -d odin_load -c "SELECT string_agg(address, ',') FROM (SELECT t.address FROM tokens t JOIN routes r ON r.token_address = t.address
  WHERE r.quote_address = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' AND t.address <> '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ORDER BY t.is_stock_token, t.address LIMIT 4) x")
echo "assets: $ASSETS"

cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) \
  DATABASE_URL='postgresql://odin@/odin_load?host=/var/run/postgresql' RUNTIME_DB_POOL_MAX=$((10 * WORKERS)) \
  LLM_GLOBAL_DAILY_TOKENS=100000000000 \
  LOAD_AGENTS=$AGENTS LOAD_SECONDS=$SECONDS_ LOAD_WORKERS=$WORKERS LOAD_CONCURRENCY=$CONC LOAD_LLM_MS=$LLM_MS LOAD_ASSETS="$ASSETS" \
  node packages/runtime/scripts/load-test.ts
psql_su -c "DROP DATABASE IF EXISTS odin_load" >/dev/null
