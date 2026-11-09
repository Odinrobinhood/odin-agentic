/**
 * Staging check: run real paper ticks for the staging agent with a scripted decision provider
 * (no LLM key needed). Everything else is real: market snapshots, Risk Engine with the on-chain
 * QuoterV2, paper fill, positions, TP/SL guard arming. Nothing is signed or broadcast in paper mode.
 *
 * Run as the `odin` OS user with deploy/chain.mainnet.env loaded and STAGING_AGENT_ID set.
 */
import type { DecisionProvider } from '@odin/decision';
import { buildRuntime, runTick } from '../src/index.ts';

const agentId = process.env.STAGING_AGENT_ID!;
let next: object = {};
const scripted: DecisionProvider = {
  name: 'scripted',
  supports: () => true,
  complete: async (req) => ({ text: JSON.stringify(next), stopReason: 'end_turn', model: req.model, tokensUsed: 0 }),
};

const { pool, store, deps, usdg, weth } = buildRuntime(process.env, { providers: [scripted] });
const thesis = { claim: 'staging check', horizon_ticks: 1, invalidated_if: 'n/a' };
const show = (r: object) => console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

await pool.query("UPDATE agents SET mode = 'paper' WHERE id = $1", [agentId]);
await store.setPaperBalance(agentId, usdg, 1_000_000_000n); // 1000 USDG of paper cash
await pool.query("DELETE FROM guards WHERE position_id IN (SELECT id FROM positions WHERE agent_id = $1 AND mode = 'paper')", [agentId]);
await pool.query("DELETE FROM positions WHERE agent_id = $1 AND mode = 'paper' AND token_address = $2", [agentId, weth.toLowerCase()]);
await pool.query(
  `INSERT INTO tp_sl_defaults (agent_id, sl_enabled, sl_mode, sl_value, tp_enabled, tp_mode, tp_value) VALUES ($1, true, 'pct', 5, true, 'pct', 10)
   ON CONFLICT (agent_id) DO UPDATE SET sl_enabled = true, sl_mode = 'pct', sl_value = 5, tp_enabled = true, tp_mode = 'pct', tp_value = 10`,
  [agentId],
);

console.log('-- buy 100 USDG of WETH (paper):');
next = { action: 'buy', token: weth, size: { type: 'quote_amount', value: '100' }, rationale: 'staging buy', thesis, confidence: 0.5 };
show(await runTick(deps, agentId));

console.log('-- buy 5000 USDG (more than paper cash, expect insufficient_balance):');
next = { ...next, size: { type: 'quote_amount', value: '5000' } };
show(await runTick(deps, agentId));

console.log('-- sell half the WETH position (paper):');
next = { action: 'sell', token: weth, size: { type: 'fraction_of_position', value: '0.5' }, rationale: 'staging sell', thesis, confidence: 0.5 };
show(await runTick(deps, agentId));

console.log('-- token outside assets (llm_invalid_output, held):');
next = { ...next, token: '0x000000000000000000000000000000000000dead' };
show(await runTick(deps, agentId));

const pos = await pool.query(
  `SELECT t.symbol, p.qty, round(p.avg_entry_price, 4) AS avg_entry FROM positions p JOIN tokens t ON t.address = p.token_address
    WHERE p.agent_id = $1 AND p.mode = 'paper' ORDER BY t.symbol`,
  [agentId],
);
console.log('-- paper positions:', JSON.stringify(pos.rows));
const g = await pool.query(
  `SELECT g.type, g.mode, g.value, round(g.trigger_price, 4) AS trigger, g.state FROM guards g JOIN positions p ON p.id = g.position_id
    WHERE p.agent_id = $1 AND p.mode = 'paper' ORDER BY g.type`,
  [agentId],
);
console.log('-- guards:', JSON.stringify(g.rows));
await pool.end();
