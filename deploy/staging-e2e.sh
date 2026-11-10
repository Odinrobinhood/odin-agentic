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

echo "== signer vault is append-only and out of the app role's reach (each line must say DENIED)"
deny() { if sudo -u "$1" psql -qtAX -d odin -c "$2" >/dev/null 2>&1; then echo "ALLOWED (BAD): $1: $2"; else echo "DENIED: $1: $2"; fi; }
deny odin "UPDATE signer.wallet_bindings SET owner = owner"
deny odin "DELETE FROM signer.signatures WHERE false"
deny odin "INSERT INTO signer.exports (nonce, agent_id) VALUES ('x', gen_random_uuid())"
deny odin "DROP TABLE signer.exports"
deny odin "ALTER SCHEMA signer OWNER TO odin"
deny odin-signer "UPDATE signer.wallet_bindings SET owner = owner"
deny odin-signer "DELETE FROM signer.signatures WHERE false"

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
# the signer signs only for live-mode agents; this wallet is an unfunded staging wallet, so nothing can land
psql_su -d odin -c "UPDATE agents SET mode = 'live' WHERE name = 'staging-e2e'" >/dev/null
echo "-- paper-mode agent is refused by the signer:"
psql_su -d odin -c "UPDATE agents SET mode = 'paper' WHERE name = 'staging-e2e'" >/dev/null
PAPER_AGENT=$(psql_su -d odin -c "SELECT id FROM agents WHERE name = 'staging-e2e'")
curl -s -m 30 -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d "{\"agentId\":\"$PAPER_AGENT\",\"swap\":{\"path\":\"0x${USDG#0x}0001f4${WETH#0x}\",\"amountIn\":\"1\"},\"amountOutMin\":\"1\",\"gasParams\":{\"nonce\":0,\"gas\":\"300000\",\"maxFeePerGas\":\"100000000\",\"maxPriorityFeePerGas\":\"0\"}}" \
  http://127.0.0.1:7401/v1/swap | jq -c .error
psql_su -d odin -c "UPDATE agents SET mode = 'live' WHERE name = 'staging-e2e'" >/dev/null
AGENT=$(psql_su -d odin -c "SELECT id FROM agents WHERE name='staging-e2e'")
echo "agent $AGENT index $IDX wallet $(psql_su -d odin -c "SELECT address FROM agent_wallets WHERE agent_id='$AGENT'")"

path() { echo "0x${1:2}$(printf '%06x' $2)${3:2}"; }
GAS='"gasParams":{"nonce":0,"gas":"800000","maxFeePerGas":"20000000","maxPriorityFeePerGas":"0"}'
# the market's own route (deepest pool), and amountOutMin 1% under the QuoterV2 quote (what the risk engine sends)
SELL=$(psql_su -d odin -c "SELECT path FROM routes WHERE token_address = '$WETH' AND quote_address = '$USDG'")
FEE=$((16#${SELL:42:6}))
BUY=$(path $USDG $FEE $WETH)
minout() { (cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) node packages/risk/scripts/quote.ts "$1" "$2" 100); }
BUY_MIN=$(minout "$BUY" 1000000)
SELL_MIN=$(minout "$SELL" 1000000000000)
echo "USDG/WETH route fee $FEE; minOut buy $BUY_MIN sell $SELL_MIN"
echo "-- amountOutMin far below the signer's own quote (slippage_too_high):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1000000\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c .error
echo "-- near-empty pool at another fee tier (no_pool, under 25% of the deepest):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$(path $USDG 10000 $WETH)\",\"amountIn\":\"1000000\"},\"amountOutMin\":\"1\",$GAS}" /v1/swap | jq -c .error

echo "-- agent buy WETH with USDG (should sign):"
post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$BUY\",\"amountIn\":\"1000000\"},\"amountOutMin\":\"$BUY_MIN\",$GAS}" /v1/swap | jq -c '{txHash, to, deadline, error}'
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
post "$GT" 7402 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$SELL\",\"amountIn\":\"1000000000000\"},\"amountOutMin\":\"$SELL_MIN\",$GAS}" /v1/swap | jq -c '{txHash, to, error}'
echo "-- agent token on guard port (unauthorized):"
post "$AT" 7402 '{}' /v1/swap | jq -c .error
echo "-- real Robinhood Stock Token (NVDA): registry flags it, signer runs paused()/tokenPaused() and signs a buy"
NVDA=$(psql_su -d odin -c "SELECT address FROM token_catalog WHERE upper(symbol) = 'NVDA' AND error IS NULL ORDER BY depth_usdg DESC NULLS LAST LIMIT 1")
if [ -n "$NVDA" ]; then
  (cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) node packages/market/scripts/add-token.ts "$NVDA" | jq -c '{symbol: .token.symbol, stock: .token.isStockToken, routes: [.routes[].quote]}')
  psql_su -d odin -c "INSERT INTO agent_assets (agent_id, token_address) VALUES ('$AGENT', '$NVDA') ON CONFLICT DO NOTHING" >/dev/null
  NBUY=$(psql_su -d odin -c "SELECT path FROM routes WHERE token_address = '$NVDA' AND quote_address = '$USDG'")
  # routes are stored token -> quote (sell); reverse the hops for the buy
  NBUY=$(node -e 'const h=process.argv[1].slice(2);const t=[],f=[];let i=0;for(;;){t.push(h.slice(i,i+40));i+=40;if(i>=h.length)break;f.push(h.slice(i,i+6));i+=6}console.log("0x"+t.reverse().map((x,k)=>x+(f.slice().reverse()[k]??"")).join(""))' "$NBUY")
  post "$AT" 7401 "{\"agentId\":\"$AGENT\",\"swap\":{\"path\":\"$NBUY\",\"amountIn\":\"1000000\"},\"amountOutMin\":\"$(minout "$NBUY" 1000000)\",${GAS/\"nonce\":0/\"nonce\":1}}" /v1/swap | jq -c '{txHash, to, error}'
  psql_su -d odin -c "DELETE FROM agent_assets WHERE agent_id = '$AGENT' AND token_address = '$NVDA'" >/dev/null
else
  echo "NVDA not in the catalog yet"
fi
echo "-- ledger rows:"
psql_su -d odin -c "SELECT channel, kind, count(*) FROM signer.signatures WHERE agent_id='$AGENT' GROUP BY 1,2 ORDER BY 1,2"
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

echo "== price triggers on the real WETH price"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" node packages/runtime/scripts/staging-triggers.ts)

echo "== backtest on recorded prices (scripted model)"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" node packages/backtest/scripts/staging-backtest.ts)

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

echo "== indexer: streams and indexed rows (real Robinhood Chain logs)"
psql_su -d odin -c "SELECT stream, last_block - start_block AS blocks_done FROM indexer_state WHERE contract IS NOT NULL ORDER BY stream"
psql_su -d odin -c "SELECT (SELECT count(*) FROM transfers) AS transfers, (SELECT count(*) FROM swaps) AS swaps"

echo "== analyst tools on real data (scripted model, no LLM key needed)"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) node packages/analyst/scripts/staging-analyst.ts)

echo "== web app BFF: SIWE via httpOnly cookies, CSRF header, security headers"
sleep 3
(cd "$APP/apps/web" && sudo -u odin node scripts/staging-web.mjs)

echo "== watchdog (real data; staging agent briefly live so low gas must fire)"
(cd "$APP" && sudo -u odin env $(grep -hv '^#' /etc/odin/chain.env /etc/odin/watchdog.env | xargs) STAGING_AGENT_ID="$AGENT" node packages/watchdog/scripts/staging-watchdog.ts)

echo "== backup + restore test"
systemctl start odin-backup.service && journalctl -u odin-backup --no-pager -n 1 -o cat
systemctl start odin-restore-test.service; journalctl -u odin-restore-test --no-pager -n 1 -o cat

echo "== /healthz of every service (build commit)"
for p in 7401 7500 7601 7603 7604 7605 7606 7607; do curl -s -m 3 http://127.0.0.1:$p/healthz | jq -c '{service: (.service // .channel // "api"), ok, commit: (.commit[0:7])}'; done

echo "== token catalog (every pool from the factory)"
psql_su -d odin -c "SELECT (SELECT count(*) FROM discovered_pools) AS pools, (SELECT count(*) FROM token_catalog) AS tokens, (SELECT count(*) FROM token_catalog WHERE tradable) AS tradable"
psql_su -d odin -c "SELECT symbol, is_stock_token, round(depth_usdg) FROM token_catalog WHERE tradable AND error IS NULL ORDER BY depth_usdg DESC NULLS LAST LIMIT 8"

echo "== executor: signer -> real mainnet RPC broadcast from the unfunded staging wallet (must be refused: insufficient_gas)"
(cd "$APP" && sudo -u odin env $(grep -v '^#' /etc/odin/chain.env | xargs) STAGING_AGENT_ID="$AGENT" \
  node packages/executor/scripts/staging-check.ts)

echo "== public status page and code reference (no account)"
curl -s -m 20 http://127.0.0.1:7500/v1/public/status | jq -c '{overall, services: [.services[] | "\(.name)=\(.status)"], data}'
echo "codes documented: $(curl -s -m 10 http://127.0.0.1:7500/v1/public/codes | jq length)"
echo "web /status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/status)  /docs: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/docs)  /api/public/status: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/public/status)  /api/public/secret: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/public/agents)"

echo "== web CSP: nonce-based, no 'unsafe-inline' for scripts, every script tag carries the nonce"
H=$(curl -s -D - -o /tmp/odin-docs.html http://127.0.0.1:3000/docs | tr -d '\r')
CSP=$(echo "$H" | grep -i '^content-security-policy:' | cut -d' ' -f2-)
N=$(echo "$CSP" | grep -o "nonce-[^' ]*" | head -1 | cut -c7-)
echo "script-src: $(echo "$CSP" | tr ';' '\n' | grep script-src)"
TOTAL=$(grep -o '<script[^>]*>' /tmp/odin-docs.html | wc -l)
WITH=$(grep -o '<script[^>]*>' /tmp/odin-docs.html | grep -c "nonce=\"$N\"")
echo "scripts: $TOTAL, with this request's nonce: $WITH"
