/**
 * Staging check: drive the real Executor against the running signer and real mainnet RPCs with the
 * unfunded staging agent. The node must refuse the broadcast (no ETH for gas), so nothing lands on chain;
 * this proves signer → executor → RPC → classification → DB end to end.
 *
 * Run as the `odin` OS user with deploy/chain.mainnet.env loaded and STAGING_AGENT_ID set.
 */
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { createPool } from '@odin/db';
import { encodePath } from '@odin/shared';
import { Executor, FallbackChain, HttpSignerClient, PgExecutionStore, checkNonce, loadExecutorConfig } from '../src/index.ts';

const env = process.env;
const agentId = env.STAGING_AGENT_ID!;
const cfg = loadExecutorConfig(env);
const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const chain = new FallbackChain(cfg.rpcUrls);
const store = new PgExecutionStore(pool);
const signer = new HttpSignerClient(env.SIGNER_AGENT_URL!, readFileSync(env.SIGNER_AGENT_TOKEN_FILE!, 'utf8').trim());
const executor = new Executor({ config: cfg, chain, signer, store });

const w = await pool.query<{ address: string }>('SELECT address FROM agent_wallets WHERE agent_id = $1', [agentId]);
const wallet = getAddress(w.rows[0]!.address);
const d = await pool.query<{ id: string }>(
  "INSERT INTO decisions (agent_id, mode, origin, action, token_address) VALUES ($1, 'live', 'user_close', 'buy', $2) RETURNING id",
  [agentId, env.CHAIN_WETH!.toLowerCase()],
);

const out = await executor.executeSwap({
  decisionId: d.rows[0]!.id,
  agentId,
  wallet,
  channel: 'agent',
  path: encodePath([getAddress(env.CHAIN_USDG!), getAddress(env.CHAIN_WETH!)], [500]),
  amountIn: 1_000_000n,
  amountOutMin: 1n,
});
console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const rows = await pool.query('SELECT kind, status, nonce, rpc, error_code FROM executions WHERE decision_id = $1', [d.rows[0]!.id]);
console.log(JSON.stringify(rows.rows));
console.log(JSON.stringify(await checkNonce(chain, store, wallet)));
await pool.end();
