/**
 * Staging check: price triggers against the real WETH snapshot. A config version with a trigger that holds
 * now (WETH above 1 USDG) must wake the staging agent once, record why, and not fire again on the next pass.
 * A follow-up version without triggers restores the agent. Run as `odin` with chain.env and STAGING_AGENT_ID.
 */
import { createPool } from '@odin/db';
import { PgRuleData } from '@odin/signals';
import { PgSchedule, PgTriggerStore, TriggerWatcher } from '../src/index.ts';

const agentId = process.env.STAGING_AGENT_ID!;
const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const newVersion = (triggers: unknown[]) =>
  pool.query(
    `INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, context_inputs, cadence_seconds, triggers)
     SELECT agent_id, version + 1, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, context_inputs, 3600, $2
       FROM agent_configs WHERE agent_id = $1 ORDER BY version DESC LIMIT 1`,
    [agentId, JSON.stringify(triggers)],
  );
const hadSchedule = !!(await pool.query('SELECT 1 FROM agent_schedule WHERE agent_id = $1', [agentId])).rowCount;
try {
  await newVersion([{ condition: 'price_above', token: process.env.CHAIN_WETH, price: 1 }]);
  const w = new TriggerWatcher({ store: new PgTriggerStore(pool), data: new PgRuleData(pool, process.env.CHAIN_RPC_URLS!.split(',')) });
  const first = (await w.checkOnce()).filter((f) => f.agentId === agentId);
  console.log('-- first pass fired:', JSON.stringify(first));
  const second = (await w.checkOnce()).filter((f) => f.agentId === agentId);
  console.log('-- second pass (condition still holds) fired:', JSON.stringify(second));
  const reason = await new PgSchedule(pool).takeWakeReason(agentId);
  console.log('-- wake reason for the tick:', JSON.stringify({ condition: reason?.condition, price: (reason?.detail as { price?: number })?.price }));
} finally {
  await newVersion([]);
  if (!hadSchedule) await pool.query('DELETE FROM agent_schedule WHERE agent_id = $1', [agentId]);
  await pool.query('DELETE FROM agent_trigger_state WHERE agent_id = $1', [agentId]);
  await pool.end();
}
