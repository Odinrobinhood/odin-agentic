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
chown -R root:root "$APP.new" && chmod -R go-w "$APP.new"
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
install -m 0644 "$APP/deploy/chain.mainnet.env" /etc/odin/chain.env

# --- database ------------------------------------------------------------------------------------
psql_su() { sudo -u postgres psql -qtAX "$@"; }
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin'"        | grep -q 1 || psql_su -c "CREATE ROLE odin LOGIN"
psql_su -c "SELECT 1 FROM pg_roles WHERE rolname='odin_signer'" | grep -q 1 || psql_su -c "CREATE ROLE odin_signer LOGIN"
psql_su -c "SELECT 1 FROM pg_database WHERE datname='odin'"     | grep -q 1 || psql_su -c "CREATE DATABASE odin OWNER odin"
psql_su -d odin -c "CREATE EXTENSION IF NOT EXISTS timescaledb; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# peer auth: OS user odin-signer -> DB role odin_signer, nothing else
PGDIR=$(dirname "$(psql_su -c 'SHOW hba_file')")
grep -q '^odinsigner ' "$PGDIR/pg_ident.conf" || echo 'odinsigner odin-signer odin_signer' >> "$PGDIR/pg_ident.conf"
if ! grep -q 'map=odinsigner' "$PGDIR/pg_hba.conf"; then
  sed -i '0,/^local/s//local   odin   odin_signer   peer map=odinsigner\nlocal/' "$PGDIR/pg_hba.conf"
fi
systemctl reload postgresql

sudo -u odin env DATABASE_URL='postgresql://odin@/odin?host=/var/run/postgresql' node "$APP/packages/db/src/migrate.ts"

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
