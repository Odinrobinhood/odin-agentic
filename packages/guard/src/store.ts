import { getAddress, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';
import type { Mode } from '@odin/risk';

export type ArmedGuard = { id: string; type: 'stop_loss' | 'take_profit'; triggerPrice: number; firstTriggeredAt: Date | null; attempts: number };

export type WatchedPosition = {
  positionId: string;
  agentId: string;
  mode: Mode;
  token: Address;
  tokenDecimals: number;
  quote: Address;
  quoteDecimals: number;
  qty: bigint;
  deviationTimeoutSeconds: number;
  guards: ArmedGuard[];
};

export interface GuardStore {
  /** Positions with at least one armed guard, for agents that are active or paused (retired disables guards). */
  watched(): Promise<WatchedPosition[]>;
  route(token: Address, quote: Address): Promise<Hex | null>;
  /** Set first_triggered_at once (kept across retries) and return it. */
  markTriggered(guardId: string): Promise<Date>;
  /** The price moved back across the trigger before an exit succeeded: start over. */
  clearTrigger(guardId: string): Promise<void>;
  recordFailure(guardId: string, code: string): Promise<void>;
  markFired(guardId: string): Promise<void>;
  alert(sourceId: string, payload: Record<string, unknown>): Promise<void>;
  /** Take pending close-all requests (pending → processing), skipping rows another watcher holds. */
  claimCloseRequests(): Promise<{ id: string; agentId: string; mode: Mode }[]>;
  finishCloseRequest(id: string, status: 'done' | 'partial', result: unknown): Promise<void>;
  /** Every open non-quote position of an agent in one mode, guarded or not. */
  openPositions(agentId: string, mode: Mode): Promise<WatchedPosition[]>;
}

export class PgGuardStore implements GuardStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async claimCloseRequests(): Promise<{ id: string; agentId: string; mode: Mode }[]> {
    const r = await this.pool.query<{ id: string; agent_id: string; mode: Mode }>(
      `UPDATE close_requests SET status = 'processing'
        WHERE id IN (SELECT id FROM close_requests WHERE status = 'pending' ORDER BY requested_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING id, agent_id, mode`,
    );
    return r.rows.map((x) => ({ id: x.id, agentId: x.agent_id, mode: x.mode }));
  }

  async finishCloseRequest(id: string, status: 'done' | 'partial', result: unknown): Promise<void> {
    await this.pool.query('UPDATE close_requests SET status = $2, result = $3, processed_at = now() WHERE id = $1', [id, status, JSON.stringify(result)]);
  }

  async openPositions(agentId: string, mode: Mode): Promise<WatchedPosition[]> {
    const r = await this.pool.query<{
      position_id: string; token_address: string; token_decimals: number; quote_asset: string; quote_decimals: number; qty: string; deviation_timeout_seconds: number | null;
    }>(
      `SELECT p.id AS position_id, p.token_address, t.decimals AS token_decimals, c.quote_asset, q.decimals AS quote_decimals, p.qty, d.deviation_timeout_seconds
         FROM positions p
         JOIN agents a ON a.id = p.agent_id
         JOIN tokens t ON t.address = p.token_address
         JOIN LATERAL (SELECT quote_asset FROM agent_configs c WHERE c.agent_id = a.id ORDER BY version DESC LIMIT 1) c ON true
         JOIN tokens q ON q.address = c.quote_asset
         LEFT JOIN tp_sl_defaults d ON d.agent_id = a.id
        WHERE p.agent_id = $1 AND p.mode = $2 AND p.qty > 0 AND p.token_address <> c.quote_asset AND a.status IN ('active', 'paused')`,
      [agentId, mode],
    );
    return r.rows.map((x) => ({
      positionId: x.position_id, agentId, mode, token: getAddress(x.token_address), tokenDecimals: x.token_decimals,
      quote: getAddress(x.quote_asset), quoteDecimals: x.quote_decimals, qty: BigInt(x.qty),
      deviationTimeoutSeconds: x.deviation_timeout_seconds ?? 300, guards: [],
    }));
  }

  async watched(): Promise<WatchedPosition[]> {
    const r = await this.pool.query<{
      position_id: string; agent_id: string; mode: Mode; token_address: string; token_decimals: number; quote_asset: string;
      quote_decimals: number; qty: string; deviation_timeout_seconds: number | null;
      guard_id: string; type: ArmedGuard['type']; trigger_price: string; first_triggered_at: Date | null; attempts: number;
    }>(
      `SELECT p.id AS position_id, p.agent_id, p.mode, p.token_address, t.decimals AS token_decimals, c.quote_asset,
              q.decimals AS quote_decimals, p.qty, d.deviation_timeout_seconds,
              g.id AS guard_id, g.type, g.trigger_price, g.first_triggered_at, g.attempts
         FROM guards g
         JOIN positions p ON p.id = g.position_id
         JOIN agents a ON a.id = p.agent_id
         JOIN tokens t ON t.address = p.token_address
         JOIN LATERAL (SELECT quote_asset FROM agent_configs c WHERE c.agent_id = a.id ORDER BY version DESC LIMIT 1) c ON true
         JOIN tokens q ON q.address = c.quote_asset
         LEFT JOIN tp_sl_defaults d ON d.agent_id = a.id
        WHERE g.state = 'armed' AND a.status IN ('active', 'paused') AND p.qty > 0 AND p.token_address <> c.quote_asset
        ORDER BY p.id, g.type`,
    );
    const out = new Map<string, WatchedPosition>();
    for (const x of r.rows) {
      let p = out.get(x.position_id);
      if (!p) {
        p = {
          positionId: x.position_id, agentId: x.agent_id, mode: x.mode,
          token: getAddress(x.token_address), tokenDecimals: x.token_decimals,
          quote: getAddress(x.quote_asset), quoteDecimals: x.quote_decimals,
          qty: BigInt(x.qty), deviationTimeoutSeconds: x.deviation_timeout_seconds ?? 300, guards: [],
        };
        out.set(x.position_id, p);
      }
      p.guards.push({ id: x.guard_id, type: x.type, triggerPrice: Number(x.trigger_price), firstTriggeredAt: x.first_triggered_at, attempts: x.attempts });
    }
    return [...out.values()];
  }

  async route(token: Address, quote: Address): Promise<Hex | null> {
    const r = await this.pool.query<{ path: Hex }>('SELECT path FROM routes WHERE token_address = $1 AND quote_address = $2', [token.toLowerCase(), quote.toLowerCase()]);
    return r.rows[0]?.path ?? null;
  }

  async markTriggered(guardId: string): Promise<Date> {
    const r = await this.pool.query<{ t: Date }>(
      `UPDATE guards SET first_triggered_at = COALESCE(first_triggered_at, now()) WHERE id = $1 RETURNING first_triggered_at AS t`,
      [guardId],
    );
    return r.rows[0]!.t;
  }

  async clearTrigger(guardId: string): Promise<void> {
    await this.pool.query(`UPDATE guards SET first_triggered_at = NULL, attempts = 0, last_rejection_code = NULL WHERE id = $1 AND state = 'armed'`, [guardId]);
  }

  async recordFailure(guardId: string, code: string): Promise<void> {
    await this.pool.query('UPDATE guards SET attempts = attempts + 1, last_rejection_code = $2 WHERE id = $1', [guardId, code]);
  }

  async markFired(guardId: string): Promise<void> {
    await this.pool.query(`UPDATE guards SET state = 'fired' WHERE id = $1`, [guardId]);
  }

  async alert(sourceId: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(`INSERT INTO alert_events (source, source_id, payload) VALUES ('guard', $1, $2)`, [sourceId, JSON.stringify(payload)]);
  }
}
