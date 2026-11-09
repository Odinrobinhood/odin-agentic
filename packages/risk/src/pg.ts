import { getAddress, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';
import type { RiskStore } from './ports.ts';
import type { AgentRiskContext, Mode, RiskProfile } from './types.ts';

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export class PgRiskStore implements RiskStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async loadAgent(agentId: string): Promise<AgentRiskContext | null> {
    const head = await this.pool.query<{
      status: AgentRiskContext['status'];
      address: string;
      quote_asset: string | null;
      max_position_pct: string | null;
      max_exposure_pct: string | null;
      max_daily_loss_pct: string | null;
      max_trades_per_day: number | null;
      max_slippage_bps: number | null;
    }>(
      `SELECT a.status, w.address,
              (SELECT c.quote_asset FROM agent_configs c WHERE c.agent_id = a.id ORDER BY c.version DESC LIMIT 1) AS quote_asset,
              r.max_position_pct, r.max_exposure_pct, r.max_daily_loss_pct, r.max_trades_per_day, r.max_slippage_bps
         FROM agents a
         JOIN agent_wallets w ON w.agent_id = a.id
         LEFT JOIN risk_profiles r ON r.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    );
    const row = head.rows[0];
    if (!row || row.quote_asset === null) return null;

    const tokens = await this.pool.query<{ address: string; decimals: number; is_stock_token: boolean; is_asset: boolean }>(
      `SELECT t.address, t.decimals, t.is_stock_token, (aa.agent_id IS NOT NULL) AS is_asset
         FROM tokens t
         LEFT JOIN agent_assets aa ON aa.token_address = t.address AND aa.agent_id = $1
        WHERE aa.agent_id IS NOT NULL OR t.address = $2`,
      [agentId, row.quote_asset],
    );

    const assets = new Set<Address>();
    const stockTokens = new Set<Address>();
    const decimals = new Map<Address, number>();
    for (const t of tokens.rows) {
      const a = getAddress(t.address);
      decimals.set(a, t.decimals);
      if (t.is_asset) assets.add(a);
      if (t.is_stock_token) stockTokens.add(a);
    }
    const profile: RiskProfile = {
      maxPositionPct: num(row.max_position_pct),
      maxExposurePct: num(row.max_exposure_pct),
      maxDailyLossPct: num(row.max_daily_loss_pct),
      maxTradesPerDay: row.max_trades_per_day,
      maxSlippageBps: row.max_slippage_bps,
    };
    return { agentId, status: row.status, wallet: getAddress(row.address), quoteAsset: getAddress(row.quote_asset), assets, stockTokens, decimals, profile };
  }

  async route(token: Address, quote: Address): Promise<Hex | null> {
    const r = await this.pool.query<{ path: string }>('SELECT path FROM routes WHERE token_address = $1 AND quote_address = $2', [
      token.toLowerCase(),
      quote.toLowerCase(),
    ]);
    return (r.rows[0]?.path as Hex | undefined) ?? null;
  }

  async tradesToday(agentId: string, mode: Mode, dayStart: Date, excludeDecisionId?: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM decisions d
        WHERE d.agent_id = $1 AND d.mode = $2 AND d.origin = 'agent' AND d.action IN ('buy', 'sell')
          AND d.created_at >= $3 AND ($4::uuid IS NULL OR d.id <> $4::uuid)
          AND NOT EXISTS (SELECT 1 FROM rejections r WHERE r.decision_id = d.id)`,
      [agentId, mode, dayStart, excludeDecisionId ?? null],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async dayBaseline(agentId: string, mode: Mode, day: string, currentNav: number): Promise<number> {
    await this.pool.query(
      `INSERT INTO risk_day_baselines (agent_id, mode, day, nav_quote) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [agentId, mode, day, currentNav],
    );
    const r = await this.pool.query<{ nav_quote: string }>('SELECT nav_quote FROM risk_day_baselines WHERE agent_id = $1 AND mode = $2 AND day = $3', [
      agentId,
      mode,
      day,
    ]);
    return Number(r.rows[0]!.nav_quote);
  }
}
