/**
 * Staging check, run as OS user odin-guard: one watcher pass over the staging agent's paper position,
 * first untouched (nothing fires at market), then with the stop loss moved above market so it must fire
 * at the real realizable price. Paper mode: nothing is signed or broadcast.
 */
import { buildGuard } from '../src/index.ts';

const agentId = process.env.STAGING_AGENT_ID!;
const { pool, watcher } = buildGuard();
const show = (x: unknown) => console.log(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const state = async () =>
  (
    await pool.query(
      `SELECT t.symbol, p.qty, g.type, round(g.trigger_price, 2) AS trigger, g.state FROM positions p
         JOIN tokens t ON t.address = p.token_address LEFT JOIN guards g ON g.position_id = p.id
        WHERE p.agent_id = $1 AND p.mode = 'paper' ORDER BY t.symbol, g.type`,
      [agentId],
    )
  ).rows;

console.log('-- pass at market (expect no events for this agent):');
show((await watcher.checkOnce()).filter((e) => e.kind !== 'unpriced'));

console.log('-- move stop loss to 100000 (above market) and pass again (expect fired):');
await pool.query(
  `UPDATE guards SET trigger_price = 100000 WHERE type = 'stop_loss' AND state = 'armed'
     AND position_id IN (SELECT id FROM positions WHERE agent_id = $1 AND mode = 'paper')`,
  [agentId],
);
show(await watcher.checkOnce());
console.log('-- positions and guards after:');
show(await state());
const a = await pool.query(`SELECT payload->>'event' AS event, payload->>'type' AS type FROM alert_events WHERE source = 'guard' ORDER BY created_at DESC LIMIT 1`);
console.log('-- latest guard alert:', JSON.stringify(a.rows[0]));
await pool.end();
