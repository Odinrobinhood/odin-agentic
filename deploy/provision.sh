#!/usr/bin/env bash
# Idempotent provisioning for a single-host staging box. Run as root from the unpacked release dir.
# Usage: provision.sh <release-tarball>
set -euo pipefail
TARBALL="$1"
APP=/opt/odin/app

# --- OS users: app (odin), guard watcher (odin-guard), signer (odin-signer) -----------------------
id odin        >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/odin --shell /usr/sbin/nologin odin
id odin-guard  >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin odin-guard
id odin-signer >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/odin-signer --shell /usr/sbin/nologin odin-signer
chmod 0711 /opt/odin

# --- code: owned by root, read-only to every service user ---------------------------------------
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new"
(cd "$APP.new" && CI=1 pnpm install --frozen-lockfile --silent)
(cd "$APP.new/apps/web" && NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build >/tmp/odin-web-build.log 2>&1) || { tail -30 /tmp/odin-web-build.log; exit 1; }
chown -R root:root "$APP.new" && chmod -R go-w "$APP.new"
# the only writable path in the code tree: Next.js runtime cache
install -d -o odin -g odin -m 0700 "$APP.new/apps/web/.next/cache"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"

# --- secrets -------------------------------------------------------------------------------------
install -d -m 0755 /etc/odin
install -d -m 0751 /etc/odin/secrets
install -d -o odin-signer -g odin-signer -m 0700 /var/lib/odin-signer /var/lib/odin-signer/seed
SEED=/var/lib/odin-signer/seed/master.seed
if [ ! -f "$SEED" ]; then
  # STAGING seed. Never fund wallets derived from it. Production: KMS-encrypted seed (architecture §6).
  head -c 64 /dev/urandom > "$SEED"
fi
chown odin-signer:odin-signer "$SEED" && chmod 0400 "$SEED"
mk_token() { # file group
  [ -f "$1" ] || head -c 48 /dev/urandom | base64 | tr -d '\n=/+' > "$1"
  chown "odin-signer:$2" "$1" && chmod 0440 "$1"
}
mk_token /etc/odin/secrets/signer-agent.token odin        # readable by signer + app (agent channel)
mk_token /etc/odin/secrets/signer-guard.token odin-guard  # readable by signer + guard watcher only
install -m 0644 "$APP/deploy/signer.mainnet.env" /etc/odin/signer.env
# build commit for /healthz (git archive stores it in the tarball header)
# gzip exits on SIGPIPE once git has read the header (exit 141): never let that abort provisioning
COMMIT=$(gzip -dc "$TARBALL" 2>/dev/null | git get-tar-commit-id 2>/dev/null | head -1 || true)
echo "BUILD_COMMIT=${COMMIT:-unknown}" > /etc/odin/build.env
chmod 0644 /etc/odin/build.env
install -m 0644 "$APP/deploy/chain.mainnet.env" /etc/odin/chain.env
install -m 0644 "$APP/deploy/chainlink.mainnet.json" /etc/odin/chainlink.json

# --- database ------------------------------------------------------------------------------------
psql_su() { sudo -u postgres psql -qtAX "$@"; }
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin'"        | grep -q 1 || psql_su -c "CREATE ROLE odin LOGIN"
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin_signer'" | grep -q 1 || psql_su -c "CREATE ROLE odin_signer LOGIN"
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin_guard'"  | grep -q 1 || psql_su -c "CREATE ROLE odin_guard LOGIN"
psql_su -c "SELECT 1 FROM pg_database WHERE datname='odin'"     | grep -q 1 || psql_su -c "CREATE DATABASE odin OWNER odin"
psql_su -d odin -c "CREATE EXTENSION IF NOT EXISTS timescaledb; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# peer auth: OS user odin-signer -> DB role odin_signer, nothing else
PGDIR=$(dirname "$(psql_su -c 'SHOW hba_file')")
grep -q '^odinsigner ' "$PGDIR/pg_ident.conf" || echo 'odinsigner odin-signer odin_signer' >> "$PGDIR/pg_ident.conf"
if ! grep -q 'map=odinsigner' "$PGDIR/pg_hba.conf"; then
  sed -i '0,/^local/s//local   odin   odin_signer   peer map=odinsigner\nlocal/' "$PGDIR/pg_hba.conf"
fi
# OS user odin-guard -> DB role odin_guard (guard watcher)
grep -q '^odinguard ' "$PGDIR/pg_ident.conf" || echo 'odinguard odin-guard odin_guard' >> "$PGDIR/pg_ident.conf"
if ! grep -q 'map=odinguard' "$PGDIR/pg_hba.conf"; then
  sed -i '0,/^local/s//local   odin   odin_guard    peer map=odinguard\nlocal/' "$PGDIR/pg_hba.conf"
fi
systemctl reload postgresql

# Old-code processes must not write while (or right after) migrations change data: stop the app services
# first; each is started again with the new code below. Signer and guard watcher keep running so TP/SL
# protection never pauses for a deploy.
systemctl stop odin-market odin-indexer odin-signals odin-watchdog odin-notifier odin-api odin-web odin-runtime odin-backtest 2>/dev/null || true
sudo -u odin env DATABASE_URL='postgresql://odin@/odin?host=/var/run/postgresql' node "$APP/packages/db/src/migrate.ts"

# Signer vault (migration 018): owned by a NOLOGIN role so neither the app role (owner of every public table)
# nor the signer itself can UPDATE/DELETE custody bindings, the ledger or burnt export nonces.
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin_vault'" | grep -q 1 || psql_su -c "CREATE ROLE odin_vault NOLOGIN"
psql_su -d odin -c "
  ALTER SCHEMA signer OWNER TO odin_vault;
  ALTER TABLE signer.wallet_bindings OWNER TO odin_vault;
  ALTER TABLE signer.signatures OWNER TO odin_vault;
  ALTER TABLE signer.exports OWNER TO odin_vault;
  REVOKE ALL ON ALL TABLES IN SCHEMA signer FROM odin, odin_signer;
  GRANT USAGE ON SCHEMA signer TO odin, odin_signer;
  GRANT SELECT ON ALL TABLES IN SCHEMA signer TO odin;
  GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA signer TO odin_signer;
  REVOKE INSERT ON signer_signatures, signer_exports FROM odin_signer;"

# --- signer service ------------------------------------------------------------------------------
install -m 0644 "$APP/deploy/odin-signer.service" /etc/systemd/system/odin-signer.service
systemctl daemon-reload
systemctl enable odin-signer >/dev/null 2>&1
systemctl restart odin-signer
sleep 3
systemctl --no-pager --lines=8 status odin-signer || true

# --- market data service -------------------------------------------------------------------------
install -m 0644 "$APP/deploy/odin-market.service" /etc/systemd/system/odin-market.service
systemctl daemon-reload
systemctl enable odin-market >/dev/null 2>&1
systemctl restart odin-market
sleep 5
systemctl --no-pager --lines=4 status odin-market || true

# --- API (OS user odin; JWT key readable by odin only) ---------------------------------------------
JWTKEY=/etc/odin/secrets/api-jwt.key
[ -f "$JWTKEY" ] || head -c 64 /dev/urandom > "$JWTKEY"
chown root:odin "$JWTKEY" && chmod 0440 "$JWTKEY"
install -m 0644 "$APP/deploy/api.staging.env" /etc/odin/api.env
install -m 0644 "$APP/deploy/odin-api.service" /etc/systemd/system/odin-api.service
systemctl daemon-reload
systemctl enable odin-api >/dev/null 2>&1
systemctl restart odin-api
sleep 3
systemctl --no-pager --lines=3 status odin-api || true

# --- notifier (optional TELEGRAM_BOT_TOKEN in /etc/odin/secrets/notifier.env, 0440 root:odin) ----------
[ -f /etc/odin/secrets/notifier.env ] && chown root:odin /etc/odin/secrets/notifier.env && chmod 0440 /etc/odin/secrets/notifier.env
install -m 0644 "$APP/deploy/odin-notifier.service" /etc/systemd/system/odin-notifier.service
systemctl daemon-reload
systemctl enable odin-notifier >/dev/null 2>&1
systemctl restart odin-notifier

# --- chain indexer -------------------------------------------------------------------------------
install -m 0644 "$APP/deploy/odin-indexer.service" /etc/systemd/system/odin-indexer.service
systemctl daemon-reload
systemctl enable odin-indexer >/dev/null 2>&1
systemctl restart odin-indexer

# --- signals & alerts ----------------------------------------------------------------------------
install -m 0644 "$APP/deploy/odin-signals.service" /etc/systemd/system/odin-signals.service
systemctl daemon-reload
systemctl enable odin-signals >/dev/null 2>&1
systemctl restart odin-signals

# --- web app (loopback only; reach it with: ssh -L 3000:127.0.0.1:3000 ubuntu@<host>) --------------
install -m 0644 "$APP/deploy/odin-web.service" /etc/systemd/system/odin-web.service
systemctl daemon-reload
systemctl enable odin-web >/dev/null 2>&1
systemctl restart odin-web

# --- watchdog + backups (daily dump, weekly restore test) ----------------------------------------
# services the watchdog expects up: runtime/backtest only once the LLM credential exists
EXPECTED=signer,api,web,market,guard,notifier,indexer,signals
[ -f /etc/odin/secrets/anthropic.env ] && EXPECTED=$EXPECTED,runtime,backtest
echo "WATCHDOG_SERVICES=$EXPECTED" > /etc/odin/watchdog.env
chmod 0644 /etc/odin/watchdog.env
install -d -o postgres -g postgres -m 0700 /var/backups/odin
for u in odin-watchdog.service odin-backup.service odin-backup.timer odin-restore-test.service odin-restore-test.timer; do
  install -m 0644 "$APP/deploy/$u" /etc/systemd/system/$u
done
systemctl daemon-reload
systemctl enable odin-watchdog odin-backup.timer odin-restore-test.timer >/dev/null 2>&1
systemctl restart odin-watchdog
systemctl start odin-backup.timer odin-restore-test.timer

# --- guard watcher (OS user odin-guard: guard channel token + odin_guard DB role) ----------------
install -m 0644 "$APP/deploy/odin-guard.service" /etc/systemd/system/odin-guard.service
systemctl daemon-reload
systemctl enable odin-guard >/dev/null 2>&1
systemctl restart odin-guard
sleep 3
systemctl --no-pager --lines=3 status odin-guard || true

# --- agent runtime (needs ANTHROPIC_API_KEY=... in /etc/odin/secrets/anthropic.env, mode 0440 root:odin) --------
install -m 0644 "$APP/deploy/odin-runtime.service" /etc/systemd/system/odin-runtime.service
install -m 0644 "$APP/deploy/odin-backtest.service" /etc/systemd/system/odin-backtest.service
systemctl daemon-reload
if [ -f /etc/odin/secrets/anthropic.env ]; then
  chown root:odin /etc/odin/secrets/anthropic.env && chmod 0440 /etc/odin/secrets/anthropic.env
  systemctl enable odin-runtime odin-backtest >/dev/null 2>&1
  systemctl restart odin-runtime odin-backtest
  sleep 3
  systemctl --no-pager --lines=4 status odin-runtime || true
else
  echo "odin-runtime, odin-backtest: not started (no /etc/odin/secrets/anthropic.env)"
fi
