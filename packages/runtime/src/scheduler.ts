import type { Pool } from '@odin/db';

/** Per-agent schedule with leases (architecture §3.3). */
export interface Schedule {
  /** Add a schedule row for every active agent that has none (first tick: now). */
  enroll(): Promise<number>;
  /** Lease up to `limit` due agents for `leaseMs`; no agent is ever leased to two workers at once. */
  claimDue(owner: string, limit: number, leaseMs: number): Promise<string[]>;
  /** Release the lease and schedule the next tick; repeated errors pause the agent. */
  complete(agentId: string, owner: string, result: { error?: string }): Promise<{ paused: boolean }>;
}

export const CADENCE_FLOOR_SECONDS = 60;

export class PgSchedule implements Schedule {
  private readonly pool: Pool;
  private readonly maxConsecutiveErrors: number;
  constructor(pool: Pool, opts: { maxConsecutiveErrors?: number } = {}) {
    this.pool = pool;
    this.maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 5;
  }

  async enroll(): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO agent_schedule (agent_id) SELECT a.id FROM agents a WHERE a.status = 'active'
       ON CONFLICT (agent_id) DO NOTHING`,
    );
    return r.rowCount ?? 0;
  }

  async claimDue(owner: string, limit: number, leaseMs: number): Promise<string[]> {
    const r = await this.pool.query<{ agent_id: string }>(
      `WITH due AS (
         SELECT s.agent_id FROM agent_schedule s JOIN agents a ON a.id = s.agent_id
          WHERE a.status = 'active' AND s.next_tick_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
          ORDER BY s.next_tick_at LIMIT $2
          FOR UPDATE OF s SKIP LOCKED)
       UPDATE agent_schedule s SET lease_owner = $1, lease_until = now() + make_interval(secs => $3::double precision / 1000)
         FROM due WHERE s.agent_id = due.agent_id
       RETURNING s.agent_id`,
      [owner, limit, leaseMs],
    );
    return r.rows.map((x) => x.agent_id);
  }

  async complete(agentId: string, owner: string, result: { error?: string }): Promise<{ paused: boolean }> {
    const r = await this.pool.query<{ consecutive_errors: number }>(
      `UPDATE agent_schedule s
          SET next_tick_at = now() + make_interval(secs => GREATEST($4,
                (SELECT c.cadence_seconds FROM agent_configs c WHERE c.agent_id = s.agent_id ORDER BY c.version DESC LIMIT 1))),
              lease_owner = NULL, lease_until = NULL, last_tick_at = now(),
              consecutive_errors = CASE WHEN $3::text IS NULL THEN 0 ELSE s.consecutive_errors + 1 END,
              last_error = $3
        WHERE s.agent_id = $1 AND s.lease_owner = $2
       RETURNING s.consecutive_errors`,
      [agentId, owner, result.error ?? null, CADENCE_FLOOR_SECONDS],
    );
    const errors = r.rows[0]?.consecutive_errors ?? 0;
    if (errors >= this.maxConsecutiveErrors) {
      // agents stopped by repeated errors (architecture §3.11); guards keep running for paused agents
      const p = await this.pool.query(`UPDATE agents SET status = 'paused' WHERE id = $1 AND status = 'active'`, [agentId]);
      if (p.rowCount) {
        await this.pool.query(`INSERT INTO alert_events (source, source_id, payload) VALUES ('runtime', $1, $2)`, [agentId, JSON.stringify({ event: 'agent_paused', agentId, error: result.error ?? '' })]);
      }
      return { paused: true };
    }
    return { paused: false };
  }
}
