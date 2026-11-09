import { getAddress, type Address } from 'viem';
import type { Pool } from '@odin/db';
import type { AgentRiskContext, BalanceReader, Mode } from '@odin/risk';
import { fillSide, guardTriggers, nextPosition } from './positions.ts';
import type { AgentRuntimeState, ContextInputs, DecisionRow, Fill, MarketState, PositionRow, RuntimeStore } from './types.ts';

const lc = (a: string) => a.toLowerCase();
const MAX_CANDLES = 500;

export class PgRuntimeStore implements RuntimeStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async loadAgent(agentId: string): Promise<AgentRuntimeState | null> {
    const r = await this.pool.query<{
      user_id: string; status: AgentRuntimeState['status']; mode: Mode; address: string;
      version: number; system_prompt: string; model_name: string; max_tokens: number; quote_asset: string;
      context_inputs: AgentRuntimeState['config']['contextInputs']; cadence_seconds: number;
      sl_enabled: boolean | null; sl_mode: 'pct' | 'price' | null; sl_value: string | null;
      tp_enabled: boolean | null; tp_mode: 'pct' | 'price' | null; tp_value: string | null;
    }>(
      `SELECT a.user_id, a.status, a.mode, w.address, c.version, c.system_prompt, c.model_name, c.max_tokens, c.quote_asset,
              c.context_inputs, c.cadence_seconds, d.sl_enabled, d.sl_mode, d.sl_value, d.tp_enabled, d.tp_mode, d.tp_value
         FROM agents a
         JOIN agent_wallets w ON w.agent_id = a.id
         JOIN LATERAL (SELECT * FROM agent_configs c WHERE c.agent_id = a.id ORDER BY c.version DESC LIMIT 1) c ON true
         LEFT JOIN tp_sl_defaults d ON d.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    );
    const x = r.rows[0];
    if (!x) return null;
    const toks = await this.pool.query<{ address: string; symbol: string; decimals: number; is_stock_token: boolean; is_quote: boolean }>(
      `SELECT t.address, t.symbol, t.decimals, t.is_stock_token, (t.address = $2) AS is_quote
         FROM tokens t WHERE t.address = $2 OR t.address IN (SELECT token_address FROM agent_assets WHERE agent_id = $1)`,
      [agentId, x.quote_asset],
    );
    const info = (t: (typeof toks.rows)[number]) => ({ address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals, isStockToken: t.is_stock_token });
    const quoteRow = toks.rows.find((t) => t.is_quote);
    if (!quoteRow) return null;
    return {
      agentId,
      userId: x.user_id,
      status: x.status,
      mode: x.mode,
      wallet: getAddress(x.address),
      config: {
        version: x.version,
        mandate: x.system_prompt,
        modelName: x.model_name,
        maxTokens: x.max_tokens,
        contextInputs: x.context_inputs ?? {},
        cadenceSeconds: Math.max(60, x.cadence_seconds),
      },
      quote: info(quoteRow),
      assets: toks.rows.filter((t) => !t.is_quote).map(info),
      tpSl:
        x.sl_enabled === null
          ? null
          : {
              slEnabled: x.sl_enabled, slMode: x.sl_mode, slValue: x.sl_value === null ? null : Number(x.sl_value),
              tpEnabled: !!x.tp_enabled, tpMode: x.tp_mode, tpValue: x.tp_value === null ? null : Number(x.tp_value),
            },
    };
  }

  async market(tokens: Address[], candles: ContextInputs['candles']): Promise<MarketState> {
    const latest = await this.pool.query<{ id: string; ts: Date; token_address: string; price: string }>(
      `SELECT DISTINCT ON (token_address) id, ts, token_address, price FROM market_snapshots
        WHERE token_address = ANY($1) AND ts > now() - interval '15 minutes'
        ORDER BY token_address, ts DESC`,
      [tokens.map(lc)],
    );
    const pricesUsdg = new Map<Address, number>(latest.rows.map((r) => [getAddress(r.token_address), Number(r.price)]));
    const newest = latest.rows.reduce<(typeof latest.rows)[number] | null>((a, b) => (!a || b.ts > a.ts ? b : a), null);
    const out: MarketState = { snapshotId: newest ? Number(newest.id) : null, snapshotTs: newest?.ts ?? null, pricesUsdg, candles: new Map() };
    if (candles && candles.count > 0 && candles.period_minutes > 0) {
      const count = Math.min(candles.count, MAX_CANDLES);
      const c = await this.pool.query<{ token_address: string; b: Date; o: string; h: string; l: string; c: string }>(
        `SELECT token_address, time_bucket(make_interval(mins => $2), ts) AS b,
                first(price, ts) AS o, max(price) AS h, min(price) AS l, last(price, ts) AS c
           FROM market_snapshots
          WHERE token_address = ANY($1) AND ts > now() - make_interval(mins => $2 * $3)
          GROUP BY token_address, b ORDER BY token_address, b`,
        [tokens.map(lc), Math.floor(candles.period_minutes), count],
      );
      for (const r of c.rows) {
        const t = getAddress(r.token_address);
        out.candles.set(t, [...(out.candles.get(t) ?? []), { t: r.b.toISOString(), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }]);
      }
    }
    return out;
  }

  async positions(agentId: string, mode: Mode): Promise<PositionRow[]> {
    const r = await this.pool.query<{ token_address: string; qty: string; avg_entry_price: string }>(
      `SELECT token_address, qty, avg_entry_price FROM positions WHERE agent_id = $1 AND mode = $2 AND qty > 0`,
      [agentId, mode],
    );
    return r.rows.map((x) => ({ token: getAddress(x.token_address), qty: BigInt(x.qty), avgEntryPrice: Number(x.avg_entry_price) }));
  }

  async recentDecisions(agentId: string, n: number): Promise<unknown[]> {
    if (n <= 0) return [];
    const r = await this.pool.query(
      `SELECT d.created_at, d.action, d.token_address AS token, d.size, d.rationale, d.thesis, d.confidence,
              (SELECT code FROM rejections x WHERE x.decision_id = d.id LIMIT 1) AS rejection_code
         FROM decisions d WHERE d.agent_id = $1 AND d.origin = 'agent' ORDER BY d.created_at DESC LIMIT $2`,
      [agentId, Math.min(n, 50)],
    );
    return r.rows;
  }

  async insertDecision(d: DecisionRow): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO decisions (agent_id, config_version, snapshot_id, mode, origin, action, token_address, size, rationale, thesis,
                              confidence, model, prompt_hash, response_hash, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [d.agentId, d.configVersion, d.snapshotId, d.mode, d.origin, d.action, d.token ? lc(d.token) : null,
        d.size === null ? null : JSON.stringify(d.size), d.rationale, d.thesis === null ? null : JSON.stringify(d.thesis),
        d.confidence, d.model, d.promptHash, d.responseHash, d.tokensUsed],
    );
    return r.rows[0]!.id;
  }

  async insertRejection(decisionId: string, code: string, message: string): Promise<void> {
    await this.pool.query('INSERT INTO rejections (decision_id, code, message) VALUES ($1, $2, $3)', [decisionId, code, message.slice(0, 2000)]);
  }

  async recordPaperFill(decisionId: string, f: Fill): Promise<void> {
    await this.pool.query('INSERT INTO paper_fills (decision_id, token_in, token_out, amount_in, amount_out) VALUES ($1, $2, $3, $4, $5)', [
      decisionId, lc(f.tokenIn), lc(f.tokenOut), f.amountIn.toString(), f.amountOut.toString(),
    ]);
  }

  async applyFill(agent: AgentRuntimeState, fill: Fill): Promise<void> {
    const quote = agent.quote.address;
    const { token } = fillSide(fill, quote);
    const decimals = { token: agent.assets.find((a) => a.address === token)?.decimals ?? 18, quote: agent.quote.decimals };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ id: string; qty: string; avg_entry_price: string }>(
        'SELECT id, qty, avg_entry_price FROM positions WHERE agent_id = $1 AND token_address = $2 AND mode = $3 FOR UPDATE',
        [agent.agentId, lc(token), agent.mode],
      );
      const old = cur.rows[0] ? { qty: BigInt(cur.rows[0].qty), avgEntryPrice: Number(cur.rows[0].avg_entry_price) } : null;
      const next = nextPosition(old, fill, quote, decimals);
      const pos = await client.query<{ id: string }>(
        `INSERT INTO positions (agent_id, token_address, mode, qty, avg_entry_price) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_id, token_address, mode) DO UPDATE SET qty = EXCLUDED.qty, avg_entry_price = EXCLUDED.avg_entry_price
         RETURNING id`,
        [agent.agentId, lc(token), agent.mode, next.qty.toString(), next.avgEntryPrice],
      );
      const positionId = pos.rows[0]!.id;

      if (agent.mode === 'paper') {
        // paper cash lives in a quote-asset position row
        const delta = fill.tokenIn === quote ? -fill.amountIn : fill.amountOut;
        await client.query(
          `INSERT INTO positions (agent_id, token_address, mode, qty, avg_entry_price) VALUES ($1, $2, 'paper', GREATEST($3::numeric, 0), 1)
           ON CONFLICT (agent_id, token_address, mode) DO UPDATE SET qty = GREATEST(positions.qty + $3::numeric, 0)`,
          [agent.agentId, lc(quote), delta.toString()],
        );
      }

      if (next.qty === 0n) {
        await client.query(`UPDATE guards SET state = 'cancelled' WHERE position_id = $1 AND state = 'armed'`, [positionId]);
      } else {
        // user overrides keep their own value; pct-based triggers follow the new average entry
        await client.query(
          `UPDATE guards SET trigger_price = CASE WHEN type = 'stop_loss' THEN $2 * (1 - value / 100) ELSE $2 * (1 + value / 100) END
            WHERE position_id = $1 AND set_by = 'user_override' AND mode = 'pct' AND state = 'armed'`,
          [positionId, next.avgEntryPrice],
        );
        for (const g of agent.tpSl ? guardTriggers(next.avgEntryPrice, agent.tpSl) : []) {
          await client.query(
            `INSERT INTO guards (position_id, type, mode, value, trigger_price, set_by, state)
             VALUES ($1, $2, $3, $4, $5, 'default', 'armed')
             ON CONFLICT (position_id, type) DO UPDATE
               SET mode = EXCLUDED.mode, value = EXCLUDED.value, trigger_price = EXCLUDED.trigger_price, state = 'armed',
                   first_triggered_at = NULL, attempts = 0, last_rejection_code = NULL
             WHERE guards.set_by = 'default'`,
            [positionId, g.type, g.mode, g.value, g.trigger],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Seed or reset an agent's paper quote balance (raw units). */
  async setPaperBalance(agentId: string, quote: Address, raw: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO positions (agent_id, token_address, mode, qty, avg_entry_price) VALUES ($1, $2, 'paper', $3, 1)
       ON CONFLICT (agent_id, token_address, mode) DO UPDATE SET qty = EXCLUDED.qty`,
      [agentId, lc(quote), raw.toString()],
    );
  }
}

/** Paper balances: the paper ledger in `positions` (mode = paper). No gas in paper mode. */
export class PgPaperBalances implements BalanceReader {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async token(ctx: AgentRiskContext, token: Address): Promise<bigint> {
    const r = await this.pool.query<{ qty: string }>(`SELECT qty FROM positions WHERE agent_id = $1 AND token_address = $2 AND mode = 'paper'`, [ctx.agentId, lc(token)]);
    return BigInt(r.rows[0]?.qty ?? 0);
  }
  async native(): Promise<bigint> {
    return 0n;
  }
}
