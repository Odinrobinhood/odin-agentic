/**
 * Staging check: one watchdog pass against real data. The staging agent (unfunded wallet) is switched to
 * live for the duration so the low-gas alert must fire; it is restored to paper afterwards.
 * Run as `odin` with chain.env loaded and STAGING_AGENT_ID set.
 */
import { createPool } from '@odin/db';
import { PgAlertSink, PgWatchdogData, Watchdog } from '../src/index.ts';

const agentId = process.env.STAGING_AGENT_ID!;
const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
await pool.query(`DELETE FROM watchdog_state WHERE key = $1`, [`low_gas:${agentId}`]);
const prev = (await pool.query<{ mode: string }>('SELECT mode FROM agents WHERE id = $1', [agentId])).rows[0]!.mode;
await pool.query(`UPDATE agents SET mode = 'live' WHERE id = $1`, [agentId]);
try {
  const w = new Watchdog({ data: new PgWatchdogData(pool, process.env.CHAIN_RPC_URLS!.split(',')), sink: new PgAlertSink(pool) });
  const first = await w.runOnce();
  console.log('-- findings:', JSON.stringify(first.map((f) => ({ event: f.event, sent: f.sent, operator: f.operator }))));
  const again = await w.runOnce();
  console.log('-- second pass re-sends low_gas:', again.some((f) => f.event === 'low_gas' && f.sent));
  const a = await pool.query(`SELECT payload->>'event' AS event, user_id IS NOT NULL AS to_user FROM alert_events WHERE payload->>'event' = 'low_gas' AND payload->>'agentId' = $1 ORDER BY created_at DESC LIMIT 1`, [agentId]);
  console.log('-- low_gas alert queued for the owner:', JSON.stringify(a.rows[0]));
} finally {
  await pool.query('UPDATE agents SET mode = $2 WHERE id = $1', [agentId, prev]);
  await pool.end();
}
