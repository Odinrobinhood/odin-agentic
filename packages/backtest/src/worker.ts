import { getAddress, type Address } from 'viem';
import type { Pool } from '@odin/db';
import type { DecideResult, DecisionContext } from '@odin/decision';
import { runBacktest, type BacktestInput, type PricePoint } from './simulate.ts';

/** Separate worker (architecture §3.4): takes queued backtests one at a time and stores the result. */
export class BacktestWorker {
  private readonly pool: Pool;
  private readonly decide: (ctx: DecisionContext) => Promise<DecideResult>;
  private readonly usdg: Address;

  constructor(deps: { pool: Pool; decide: (ctx: DecisionContext) => Promise<DecideResult>; usdg: Address }) {
    this.pool = deps.pool;
    this.decide = deps.decide;
    this.usdg = deps.usdg;
  }

  async runNext(): Promise<{ id: string; status: 'done' | 'failed'; error?: string } | null> {
    const job = await this.pool.query<{ id: string; agent_id: string; config_version: number; from_ts: Date; to_ts: Date; initial_capital: string }>(
      `UPDATE backtests SET status = 'running', started_at = now()
        WHERE id = (SELECT id FROM backtests WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, agent_id, config_version, from_ts, to_ts, initial_capital`,
    );
    const j = job.rows[0];
    if (!j) return null;
    try {
      const input = await this.load(j.agent_id, j.config_version, j.from_ts, j.to_ts, Number(j.initial_capital));
      const result = await runBacktest(input, this.decide, (pct) => this.pool.query('UPDATE backtests SET progress = $2 WHERE id = $1', [j.id, pct]).then(() => {}));
      await this.pool.query(`UPDATE backtests SET status = 'done', progress = 100, result = $2, finished_at = now() WHERE id = $1`, [j.id, JSON.stringify(result)]);
      return { id: j.id, status: 'done' };
    } catch (e) {
      const error = (e as Error).message.slice(0, 1000);
      await this.pool.query(`UPDATE backtests SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [j.id, error]);
      return { id: j.id, status: 'failed', error };
    }
  }

  private async load(agentId: string, version: number, from: Date, to: Date, capital: number): Promise<BacktestInput> {
    const c = await this.pool.query<{ user_id: string; system_prompt: string; model_name: string; max_tokens: number; cadence_seconds: number; context_inputs: BacktestInput['contextInputs']; quote_asset: string }>(
      `SELECT a.user_id, c.system_prompt, c.model_name, c.max_tokens, c.cadence_seconds, c.context_inputs, c.quote_asset
         FROM agent_configs c JOIN agents a ON a.id = c.agent_id WHERE c.agent_id = $1 AND c.version = $2`,
      [agentId, version],
    );
    const cfg = c.rows[0];
    if (!cfg) throw new Error(`config version ${version} not found`);
    const toks = await this.pool.query<{ address: string; symbol: string; decimals: number; is_stock_token: boolean; is_quote: boolean }>(
      `SELECT address, symbol, decimals, is_stock_token, address = $2 AS is_quote FROM tokens
        WHERE address = $2 OR address IN (SELECT token_address FROM agent_assets WHERE agent_id = $1)`,
      [agentId, cfg.quote_asset],
    );
    const info = (t: (typeof toks.rows)[number]) => ({ address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals, isStockToken: t.is_stock_token });
    const quote = toks.rows.find((t) => t.is_quote);
    const assets = toks.rows.filter((t) => !t.is_quote).map(info);
    if (!quote) throw new Error('quote asset not registered');
    if (assets.length === 0) throw new Error('agent has no assets');

    // snapshots are USDG prices; convert to the quote asset when it is not USDG
    const series = async (token: Address): Promise<PricePoint[]> => {
      const r = await this.pool.query<{ ts: Date; price: string; fee_tier: number }>(
        'SELECT ts, price, fee_tier FROM market_snapshots WHERE token_address = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts',
        [token.toLowerCase(), new Date(from.getTime() - 24 * 3600_000), to],
      );
      return r.rows.map((x) => ({ ts: x.ts.getTime(), price: Number(x.price), feeTier: x.fee_tier }));
    };
    const quoteAddr = getAddress(quote.address);
    const quoteUsdg = quoteAddr === this.usdg ? null : await series(quoteAddr);
    const prices = new Map<Address, PricePoint[]>();
    for (const a of assets) {
      const s = a.address === this.usdg ? [] : await series(a.address);
      prices.set(a.address, quoteUsdg ? s.map((p) => ({ ...p, price: p.price / (nearest(quoteUsdg, p.ts) ?? NaN) })).filter((p) => Number.isFinite(p.price)) : s);
    }
    if ([...prices.values()].every((s) => s.length === 0)) throw new Error('no price history for the assets in this window');

    const tp = await this.pool.query<{ sl_enabled: boolean; sl_mode: 'pct' | 'price'; sl_value: string; tp_enabled: boolean; tp_mode: 'pct' | 'price'; tp_value: string }>('SELECT * FROM tp_sl_defaults WHERE agent_id = $1', [agentId]);
    const t = tp.rows[0];
    return {
      agentId,
      userId: cfg.user_id,
      configVersion: version,
      mandate: cfg.system_prompt,
      model: cfg.model_name,
      maxTokens: cfg.max_tokens,
      cadenceSeconds: Math.max(60, cfg.cadence_seconds),
      contextInputs: cfg.context_inputs ?? {},
      quote: info(quote),
      assets,
      prices,
      tpSl: {
        sl: t?.sl_enabled ? { mode: t.sl_mode, value: Number(t.sl_value) } : null,
        tp: t?.tp_enabled ? { mode: t.tp_mode, value: Number(t.tp_value) } : null,
      },
      from: from.getTime(),
      to: to.getTime(),
      initialCapital: capital,
    };
  }
}

function nearest(series: PricePoint[], ts: number): number | null {
  let best: PricePoint | null = null;
  for (const p of series) if (p.ts <= ts) best = p;
  return best?.price ?? null;
}
