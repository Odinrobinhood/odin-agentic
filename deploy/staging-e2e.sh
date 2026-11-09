#!/usr/bin/env bash
# Staging end-to-end checks for the signer. Run as root on the staging host.
# Creates a throwaway test database for integration tests and a staging agent in the odin DB.
set -euo pipefail
APP=/opt/odin/app
psql_su() { sudo -u postgres psql -qtAX "$@"; }

echo "== unit + postgres integration tests"
psql_su -c "DROP DATABASE IF EXISTS odin_test" >/dev/null
psql_su -c "CREATE DATABASE odin_test OWNER odin" >/dev/null
psql_su -d odin_test -c "CREATE EXTENSION timescaledb; CREATE EXTENSION pgcrypto;" >/dev/null 2>&1
sudo -u odin env DATABASE_URL='postgresql://odin@/odin_test?host=/var/run/postgresql' node "$APP/packages/db/src/migrate.ts" | tail -1
TMP=$(mktemp -d) && cp -r "$APP/." "$TMP/" && chown -R odin "$TMP"
(cd "$TMP" && sudo -u odin env TEST_DATABASE_URL='postgresql://odin@/odin_test?host=/var/run/postgresql' \
  node_modules/.bin/vitest run 2>&1 | grep -E 'Test Files|Tests |FAIL|×|skipped')
rm -rf "$TMP"

echo "== live signer over HTTP (mainnet chain reads, nothing is broadcast)"
AT=$(cat /etc/odin/secrets/signer-agent.token)
GT=$(cat /etc/odin/secrets/signer-guard.token)
post() { curl -s -m 30 -H "authorization: Bearer $1" -H 'content-type: application/json' -d "$3" "http://127.0.0.1:$2$4"; echo; }
curl -s http://127.0.0.1:7401/healthz; echo

echo "-- bad token:";       post wrong 7401 '{}' /v1/swap
USDG=0x5fc5360d0400a0fd4f2af552add042d716f1d168
WETH=0x0bd7d308f8e1639fab988df18a8011f41eacad73

# staging agent (idempotent)
IDX=$(psql_su -d odin -c "SELECT derivation_index FROM agent_wallets w JOIN agents a ON a.id=w.agent_id WHERE a.name='staging-e2e'")
if [ -z "$IDX" ]; then
  IDX=$(psql_su -d odin -c "SELECT nextval('agent_derivation_index_seq')")
  ADDR=$(post "$AT" 7401 "{\"derivationIndex\":\"$IDX\"}" /v1/wallet | jq -r .address | tr 'A-F' 'a-f')
  psql_su -d odin >/dev/null <<SQL
INSERT INTO tokens (address, decimals, symbol, name) VALUES ('$USDG', 6, 'USDG', 'Global Dollar'), ('$WETH', 18, 'WETH', 'Wrapped Ether') ON CONFLICT DO NOTHING;
WITH u AS (INSERT INTO users (wallet_address) VALUES ('0x000000000000000000000000000000000000e2e0') ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address RETURNING id),
     a AS (INSERT INTO agents (user_id, name, status) SELECT id, 'staging-e2e', 'active' FROM u RETURNING id),
     c AS (INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, cadence_seconds)
           SELECT id, 1, 'staging', 'none', 'none', 0, 1, '$USDG', 60 FROM a RETURNING agent_id),
     w AS (INSERT INTO agent_wallets (agent_id, address, derivation_index) SELECT agent_id, '$ADDR', $IDX FROM c RETURNING agent_id)
INSERT INTO agent_assets (agent_id, token_address) SELECT agent_id, '$WETH' FROM w;
SQL
fi
AGENT=$(psql_su -d odin -c "SELECT id FROM agents WHERE name='staging-e2e'")
echo "agent $AGENT index $IDX wallet $(psql_su -d odin -c "SELECT address FROM agent_wallets WHERE agent_id='$AGENT'")"

path() { echo "0x${1:2}$(printf '%06x' $2)${3:2}"; }
GAS='"gasParams":{"nonce":0,"gas":"800000","maxFeePerGas":"20000000","maxPriorityFeePerGas":"0"}'
BUY=$(path $USDG 500 $WETH)
SELL=$(path $WETH 500 $USDG)

echo "-- agent buy WETH with USDG (should sign):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1000000\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c '{txHash, to, deadline, error}'
echo "-- approve (should be token=USDG, spender=router):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1000000\"},$GAS}" /v1/approve | jq -c '{txHash, to, error}'
echo "-- invalid fee tier 501 (bad_fee_tier):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$(path $USDG 501 $WETH)\",\"amountIn\":\"1\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c .error
echo "-- token outside assets (token_not_allowed):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$(path $USDG 500 0x000000000000000000000000000000000000dead)\",\"amountIn\":\"1\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c .error
echo "-- injected recipient field (bad_request):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1\"},\"amountOutMin\":\"1\",\"recipient\":\"0x000000000000000000000000000000000000dead\",$GAS}" /v1/swap | jq -c .error
echo "-- guard channel buying (guard_must_sell_to_quote):"
post "$GT" 7402 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c .error
echo "-- guard sell WETH to USDG (should sign):"
post "$GT" 7402 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$SELL\",\"amountIn\":\"1000\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c '{txHash, to, error}'
echo "-- agent token on guard port (unauthorized):"
post "$AT" 7402 '{}' /v1/swap | jq -c .error
echo "-- ledger rows:"
psql_su -d odin -c "SELECT channel, kind, count(*) FROM signer_signatures WHERE agent_id='$AGENT' GROUP BY 1,2 ORDER BY 1,2"
echo "-- signer DB role cannot write policy tables:"
sudo -u odin-signer psql -d odin -U odin_signer -qtAX -c "UPDATE agents SET status='active'" 2>&1 | head -1 || true  # expected to fail

echo "== market data: registry + routes + snapshots (real Robinhood Chain pools)"
CHAINENV=$(grep -v '^#' /etc/odin/chain.env | xargs)
echo "-- not a token (chain_read_failed):"
(cd "$APP" && sudo -u odin env $CHAINENV node packages/market/scripts/add-token.ts 0x000000000000000000000000000000000000dead || true)
echo "-- routes:"
psql_su -d odin -c "SELECT t.symbol, q.symbol, r.path FROM routes r JOIN tokens t ON t.address=r.token_address JOIN tokens q ON q.address=r.quote_address ORDER BY 1"
echo "-- latest snapshots (USDG per token):"
psql_su -d odin -c "SELECT ts, t.symbol, round(price::numeric, 4), fee_tier FROM market_snapshots s JOIN tokens t ON t.address=s.token_address ORDER BY ts DESC LIMIT 3"

echo "== runtime: paper ticks with a scripted decision provider (real risk engine + quoter, nothing signed)"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" \
  node packages/runtime/scripts/staging-tick.ts)

echo "== guard watcher (as odin-guard): stop loss fires at the real realizable price, even after WETH was removed from the agent assets"
systemctl stop odin-guard  # avoid racing the running watcher
# held-token exit (user decision): remove WETH from the agent's assets while the paper position is open;
# the stop loss must still fire. Restored below.
psql_su -d odin -c "DELETE FROM agent_assets WHERE agent_id = '$AGENT' AND token_address = '$WETH'"
(cd "$APP" && sudo -u odin-guard env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" \
  node packages/guard/scripts/staging-guard.ts)
psql_su -d odin -c "INSERT INTO agent_assets (agent_id, token_address) VALUES ('$AGENT', '$WETH') ON CONFLICT DO NOTHING"
systemctl start odin-guard
echo "-- isolation: odin cannot read the guard token, odin-guard cannot read the agent token:"
sudo -u odin cat /etc/odin/secrets/signer-guard.token >/dev/null 2>&1 && echo "FAIL odin read guard token" || echo "ok"
sudo -u odin-guard cat /etc/odin/secrets/signer-agent.token >/dev/null 2>&1 && echo "FAIL odin-guard read agent token" || echo "ok"

echo "== api: real SIWE login against the running API, agent created with a signer-derived wallet"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env /etc/odin/api.env | cut -d: -f2- | xargs) \
  node apps/api/scripts/staging-api.ts)

echo "== executor: signer -> real mainnet RPC broadcast from the unfunded staging wallet (must be refused: insufficient_gas)"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" \
  node packages/executor/scripts/staging-check.ts)
