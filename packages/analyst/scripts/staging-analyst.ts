/**
 * Staging check: every analyst tool against REAL data (market snapshots, indexed swaps/transfers, live
 * chain reads), driven by a scripted model (no LLM key needed). Run as `odin` with chain.env loaded.
 */
import { createPool } from '@odin/db';
import { AnalystTools } from '../src/index.ts';
import { getAddress } from 'viem';

const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const tools = new AnalystTools({
  pool,
  rpcUrls: process.env.CHAIN_RPC_URLS!.split(','),
  usdg: getAddress(process.env.CHAIN_USDG!),
  portfolio: async () => ({ note: 'portfolio stub in this check' }),
});
const show = (label: string, o: Record<string, unknown>) => console.log(label, JSON.stringify(o).slice(0, 420));

show('-- get_token WETH:', await tools.run('get_token', { query: 'WETH' }, 'u'));
show('-- get_token unknown:', await tools.run('get_token', { query: '0x000000000000000000000000000000000000dead' }, 'u'));
show('-- get_price_history WETH 15m x 4:', await tools.run('get_price_history', { token: 'WETH', period_minutes: 15, count: 4 }, 'u'));
show('-- get_pool_stats WETH 1h:', await tools.run('get_pool_stats', { token: 'WETH', hours: 1 }, 'u'));
show('-- get_flows WETH 1h:', await tools.run('get_flows', { token: 'WETH', hours: 1 }, 'u'));
show('-- get_holders WETH top 3:', await tools.run('get_holders', { token: 'WETH', top: 3 }, 'u'));
await pool.end();
