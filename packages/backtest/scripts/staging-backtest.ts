/**
 * Staging check: queue and run a real backtest of the staging agent against the recorded WETH snapshots,
 * with a scripted model (buy 100 USDG of WETH on the first tick, sell everything on the last).
 * Run as `odin` with chain.env loaded and STAGING_AGENT_ID set.
 */
import { getAddress } from 'viem';
import { createPool } from '@odin/db';
import type { DecideResult, DecisionContext } from '@odin/decision';
import { BacktestWorker } from '../src/index.ts';

const agentId = process.env.STAGING_AGENT_ID!;
const weth = getAddress(process.env.CHAIN_WETH!);
const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const meta = { model: 'scripted', promptHash: 'p', responseHash: 'r', tokensUsed: 0 };
const thesis = { claim: 'staging', horizon_ticks: 1, invalidated_if: 'n/a' };

const cfg = await pool.query<{ version: number; cadence_seconds: number }>('SELECT version, cadence_seconds FROM agent_configs WHERE agent_id = $1 ORDER BY version DESC LIMIT 1', [agentId]);
const { version, cadence_seconds } = cfg.rows[0]!;
const to = new Date(Date.now() - 60_000);
const from = new Date(to.getTime() - 6 * Math.max(60, cadence_seconds) * 1000);
const job = await pool.query<{ id: string }>(`INSERT INTO backtests (agent_id, config_version, from_ts, to_ts, status, initial_capital) VALUES ($1, $2, $3, $4, 'queued', 1000) RETURNING id`, [agentId, version, from, to]);

let tick = 0;
const decide = async (ctx: DecisionContext): Promise<DecideResult> => {
  tick++;
  const last = ctx.snapshotTs!.getTime() + Math.max(60, cadence_seconds) * 1000 > to.getTime();
  if (tick === 1) return { ok: true, decision: { action: 'buy', token: weth, size: { type: 'quote_amount', value: '100' }, rationale: 'scripted buy', thesis, confidence: 0.5 }, ...meta };
  if (last) return { ok: true, decision: { action: 'sell', token: weth, size: { type: 'fraction_of_position', value: '1' }, rationale: 'scripted exit', thesis, confidence: 0.5 }, ...meta };
  return { ok: true, decision: { action: 'hold', token: null, size: null, rationale: 'scripted hold', thesis, confidence: 0.5 }, ...meta };
};

const worker = new BacktestWorker({ pool, decide, usdg: getAddress(process.env.CHAIN_USDG!) });
let r;
do r = await worker.runNext();
while (r && r.id !== job.rows[0]!.id);
const row = (await pool.query('SELECT status, error, result FROM backtests WHERE id = $1', [job.rows[0]!.id])).rows[0];
const res = row.result;
console.log('-- backtest:', row.status, row.error ?? '', res ? JSON.stringify({ ticks: res.ticks, trades: res.trades.map((t: { action: string; price: number }) => [t.action, Number(t.price.toFixed(2))]), finalNav: Number(res.finalNav.toFixed(4)), returnPct: Number(res.returnPct.toFixed(4)), maxDrawdownPct: Number(res.maxDrawdownPct.toFixed(4)) }) : '');
await pool.end();
