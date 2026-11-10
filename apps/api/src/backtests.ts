import { z } from 'zod';
import type { Pool } from '@odin/db';
import { MAX_TICKS } from '@odin/backtest';
import { Rejection } from '@odin/shared';

export const BacktestInput = z
  .object({
    /** Defaults to the latest config version. */
    configVersion: z.number().int().positive().optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    initialCapital: z.number().positive().max(1e12).default(1000),
  })
  .strict();

/** Backtests (architecture §3.4): queued here, run by the separate odin-backtest worker. */
export class BacktestService {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(userId: string, agentId: string, b: z.infer<typeof BacktestInput>) {
    const from = new Date(b.from);
    const to = new Date(b.to);
    if (!(from < to)) throw new Rejection('bad_request', '`from` must be before `to`');
    if (to.getTime() > Date.now()) throw new Rejection('bad_request', '`to` cannot be in the future');
    const cfg = await this.pool.query<{ version: number; cadence_seconds: number }>(
      b.configVersion
        ? 'SELECT version, cadence_seconds FROM agent_configs WHERE agent_id = $1 AND version = $2'
        : 'SELECT version, cadence_seconds FROM agent_configs WHERE agent_id = $1 ORDER BY version DESC LIMIT 1',
      b.configVersion ? [agentId, b.configVersion] : [agentId],
    );
    const c = cfg.rows[0];
    if (!c) throw new Rejection('bad_request', 'no such config version');
    const ticks = Math.floor((to.getTime() - from.getTime()) / (Math.max(60, c.cadence_seconds) * 1000)) + 1;
    if (ticks > MAX_TICKS) throw new Rejection('bad_request', `this window needs ${ticks} model calls; the limit is ${MAX_TICKS}. Shorten it or raise the cadence.`);
    const first = await this.pool.query<{ t: Date | null }>('SELECT min(ts) AS t FROM market_snapshots');
    if (!first.rows[0]?.t || from < first.rows[0].t) throw new Rejection('bad_request', `price history starts at ${first.rows[0]?.t?.toISOString() ?? 'n/a'}`);
    const open = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM backtests b JOIN agents a ON a.id = b.agent_id WHERE a.user_id = $1 AND b.status IN ('queued', 'running')`,
      [userId],
    );
    if (open.rows[0]!.n >= 3) throw new Rejection('bad_request', 'at most 3 backtests can be queued or running at once');
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO backtests (agent_id, config_version, from_ts, to_ts, status, initial_capital) VALUES ($1, $2, $3, $4, 'queued', $5) RETURNING id`,
      [agentId, c.version, from, to, b.initialCapital],
    );
    return { id: r.rows[0]!.id, configVersion: c.version, ticks, status: 'queued' };
  }

  async list(agentId: string) {
    return (
      await this.pool.query(
        `SELECT id, config_version, from_ts, to_ts, initial_capital, status, progress, error, created_at, finished_at,
                result->'finalNav' AS final_nav, result->'returnPct' AS return_pct, result->'maxDrawdownPct' AS max_drawdown_pct
           FROM backtests WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [agentId],
      )
    ).rows;
  }

  async get(agentId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Rejection('bad_request', 'bad id');
    const r = await this.pool.query('SELECT * FROM backtests WHERE id = $1 AND agent_id = $2', [id, agentId]);
    if (!r.rows[0]) throw new Rejection('bad_request', 'unknown backtest');
    return r.rows[0];
  }
}
