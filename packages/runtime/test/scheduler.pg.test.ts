import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPool, type Pool } from '@odin/db';
import { PgSchedule } from '../src/scheduler.ts';
import { PgTriggerStore } from '../src/triggers.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgSchedule (postgres)', () => {
  let pool: Pool;
  let agentId: string;

  beforeAll(async () => {
    pool = createPool(url!, { max: 10 });
    const hex = () => `0x${randomBytes(20).toString('hex')}`;
    const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [hex()]);
    const a = await pool.query<{ id: string }>("INSERT INTO agents (user_id, name, status) VALUES ($1, 'sched-test', 'active') RETURNING id", [u.rows[0]!.id]);
    agentId = a.rows[0]!.id;
    const q = hex();
    await pool.query("INSERT INTO tokens (address, decimals, symbol, name) VALUES ($1, 6, 'Q', 'Q')", [q]);
    await pool.query(
      `INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, cadence_seconds)
       VALUES ($1, 1, 'm', 'anthropic', 'claude-opus-5-5', 0, 1000, $2, 120)`,
      [agentId, q],
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('leases a due agent to exactly one of many concurrent workers, then schedules by cadence', async () => {
    const s = new PgSchedule(pool);
    await s.enroll();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => s.claimDue(`w${i}`, 100, 60_000)));
    const winners = claims.map((c, i) => (c.includes(agentId) ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    // a different worker cannot complete someone else's lease
    expect((await pool.query("UPDATE agent_schedule SET lease_owner = lease_owner WHERE agent_id = $1 AND lease_owner = 'nobody'", [agentId])).rowCount).toBe(0);
    await s.complete(agentId, `w${winners[0]}`, {});
    const r = await pool.query<{ secs: number; lease_owner: string | null }>(
      'SELECT extract(epoch FROM next_tick_at - now())::int AS secs, lease_owner FROM agent_schedule WHERE agent_id = $1',
      [agentId],
    );
    expect(r.rows[0]!.lease_owner).toBeNull();
    expect(r.rows[0]!.secs).toBeGreaterThanOrEqual(118); // cadence 120s
    expect(await s.claimDue('w9', 100, 60_000)).not.toContain(agentId);
  });

  it('a trigger wake pulls the tick forward unless the agent is leased, and the reason is read once', async () => {
    const s = new PgSchedule(pool);
    const store = new PgTriggerStore(pool);
    await pool.query("UPDATE agent_schedule SET next_tick_at = now() + interval '1 hour', lease_until = now() + interval '1 minute' WHERE agent_id = $1", [agentId]);
    expect(await store.wake(agentId, { trigger: 0 })).toBe(false);
    await pool.query('UPDATE agent_schedule SET lease_until = NULL WHERE agent_id = $1', [agentId]);
    expect(await store.wake(agentId, { trigger: 0 })).toBe(true);
    expect(await s.claimDue('w', 100, 60_000)).toContain(agentId);
    expect(await s.takeWakeReason(agentId)).toEqual({ trigger: 0 });
    expect(await s.takeWakeReason(agentId)).toBeNull();
    await s.complete(agentId, 'w', {});
  });

  it('pauses an agent after repeated tick errors', async () => {
    const s = new PgSchedule(pool, { maxConsecutiveErrors: 3 });
    let paused = false;
    for (let i = 0; i < 3; i++) {
      await pool.query('UPDATE agent_schedule SET next_tick_at = now() - interval \'1 second\' WHERE agent_id = $1', [agentId]);
      expect(await s.claimDue('w', 100, 60_000)).toContain(agentId);
      paused = (await s.complete(agentId, 'w', { error: 'boom' })).paused;
    }
    expect(paused).toBe(true);
    const a = await pool.query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [agentId]);
    expect(a.rows[0]!.status).toBe('paused');
  });
});
