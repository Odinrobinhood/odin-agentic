import { getAddress, parseUnits, type Address } from 'viem';
import { z } from 'zod';
import type { Pool } from '@odin/db';
import type { TokenRegistry } from '@odin/market';
import { Rejection } from '@odin/shared';

/** Models offered at launch (architecture §11.2); must match the Decision Engine's provider. */
export const SUPPORTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

const decimalStr = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const addressStr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const ConfigInput = z
  .object({
    systemPrompt: z.string().max(20_000),
    model: z.enum(SUPPORTED_MODELS),
    maxTokens: z.number().int().min(1024).max(128_000).default(16_000),
    temperature: z.number().min(0).max(1).default(1),
    /** USDG or WETH only (base assets). */
    quoteAsset: z.enum(['USDG', 'WETH']),
    contextInputs: z
      .object({
        candles: z.object({ period_minutes: z.number().int().min(1).max(1440), count: z.number().int().min(0).max(500) }).strict().optional(),
        history: z.number().int().min(0).max(50).optional(),
      })
      .strict()
      .default({}),
    cadenceSeconds: z.number().int().min(60).max(7 * 86_400),
    triggers: z.array(z.unknown()).max(20).default([]),
  })
  .strict();

const pct = z.number().positive().max(1000).nullable();
export const RiskInput = z
  .object({
    maxPositionPct: pct.default(null),
    maxExposurePct: pct.default(null),
    maxDailyLossPct: pct.default(null),
    maxTradesPerDay: z.number().int().positive().max(100_000).nullable().default(null),
    maxSlippageBps: z.number().int().min(0).max(10_000).nullable().default(null),
  })
  .strict();

const level = z.object({ mode: z.enum(['pct', 'price']), value: z.number().positive() }).strict().nullable();
export const TpSlInput = z
  .object({ stopLoss: level, takeProfit: level, deviationTimeoutSeconds: z.number().int().min(0).max(86_400).default(300) })
  .strict();

export const GuardOverrideInput = z.object({ stopLoss: level.optional(), takeProfit: level.optional() }).strict();
export const AssetsInput = z.object({ tokens: z.array(addressStr).max(50) }).strict();
export const StatusInput = z.object({ action: z.enum(['activate', 'pause', 'resume', 'retire']) }).strict();
export const ModeInput = z.object({ mode: z.enum(['paper', 'live']) }).strict();
export const PaperFundInput = z.object({ amount: decimalStr }).strict();

export interface WalletIssuer {
  /** Public address for a derivation index, from the signer (the API never sees the seed). */
  addressFor(derivationIndex: bigint): Promise<Address>;
}

export type AgentDeps = {
  pool: Pool;
  registry: Pick<TokenRegistry, 'addToken'>;
  wallets: WalletIssuer;
  usdg: Address;
  weth: Address;
};

const notFound = () => new Rejection('unknown_agent', 'agent not found');

export class AgentService {
  private readonly d: AgentDeps;
  constructor(deps: AgentDeps) {
    this.d = deps;
  }

  /** Every agent route goes through here: the agent must belong to the caller (404 otherwise, no leak). */
  async owned(userId: string, agentId: string): Promise<{ id: string; status: string; mode: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw notFound();
    const r = await this.d.pool.query<{ id: string; status: string; mode: string }>('SELECT id, status, mode FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId]);
    if (!r.rows[0]) throw notFound();
    return r.rows[0];
  }

  async list(userId: string) {
    const r = await this.d.pool.query(
      `SELECT a.id, a.name, a.status, a.mode, a.created_at, w.address AS wallet
         FROM agents a LEFT JOIN agent_wallets w ON w.agent_id = a.id WHERE a.user_id = $1 ORDER BY a.created_at`,
      [userId],
    );
    return r.rows;
  }

  async create(userId: string, name: string) {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Rejection('bad_request', 'name is required');
    const idx = await this.d.pool.query<{ n: string }>(`SELECT nextval('agent_derivation_index_seq') AS n`);
    const derivationIndex = BigInt(idx.rows[0]!.n);
    const address = await this.d.wallets.addressFor(derivationIndex);
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      const a = await client.query<{ id: string }>(`INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, clean]);
      const id = a.rows[0]!.id;
      await client.query('INSERT INTO agent_wallets (agent_id, address, derivation_index) VALUES ($1, $2, $3)', [id, address.toLowerCase(), derivationIndex.toString()]);
      await client.query(
        `INSERT INTO tracked_wallets (user_id, address, kind, label) VALUES ($1, $2, 'agent', $3) ON CONFLICT (user_id, address) DO NOTHING`,
        [userId, address.toLowerCase(), clean],
      );
      await client.query('COMMIT');
      return { id, name: clean, status: 'draft', mode: 'paper', wallet: address };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async get(userId: string, agentId: string) {
    await this.owned(userId, agentId);
    const [a, cfg, assets, risk, tpsl] = await Promise.all([
      this.d.pool.query(`SELECT a.id, a.name, a.status, a.mode, a.created_at, w.address AS wallet, w.custody, w.exported_at FROM agents a JOIN agent_wallets w ON w.agent_id = a.id WHERE a.id = $1`, [agentId]),
      this.d.pool.query(`SELECT * FROM agent_configs WHERE agent_id = $1 ORDER BY version DESC LIMIT 1`, [agentId]),
      this.d.pool.query(`SELECT t.address, t.symbol, t.name, t.decimals, t.is_stock_token FROM agent_assets aa JOIN tokens t ON t.address = aa.token_address WHERE aa.agent_id = $1 ORDER BY t.symbol`, [agentId]),
      this.d.pool.query(`SELECT * FROM risk_profiles WHERE agent_id = $1`, [agentId]),
      this.d.pool.query(`SELECT * FROM tp_sl_defaults WHERE agent_id = $1`, [agentId]),
    ]);
    return { ...a.rows[0], config: cfg.rows[0] ?? null, assets: assets.rows, risk: risk.rows[0] ?? null, tpSl: tpsl.rows[0] ?? null };
  }

  async rename(userId: string, agentId: string, name: string) {
    await this.owned(userId, agentId);
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Rejection('bad_request', 'name is required');
    await this.d.pool.query('UPDATE agents SET name = $2 WHERE id = $1', [agentId, clean]);
  }

  /** Every change is a new version (architecture §3.5); nothing is updated in place. */
  async setConfig(userId: string, agentId: string, input: z.infer<typeof ConfigInput>) {
    await this.owned(userId, agentId);
    const quote = input.quoteAsset === 'USDG' ? this.d.usdg : this.d.weth;
    const r = await this.d.pool.query<{ version: number }>(
      `INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset,
                                  context_inputs, cadence_seconds, triggers)
       SELECT $1, COALESCE(max(version), 0) + 1, $2, 'anthropic', $3, $4, $5, $6, $7, $8, $9 FROM agent_configs WHERE agent_id = $1
       RETURNING version`,
      [agentId, input.systemPrompt, input.model, input.temperature, input.maxTokens, quote.toLowerCase(), JSON.stringify(input.contextInputs), input.cadenceSeconds, JSON.stringify(input.triggers)],
    );
    return { version: r.rows[0]!.version };
  }

  async configs(userId: string, agentId: string) {
    await this.owned(userId, agentId);
    return (await this.d.pool.query(`SELECT * FROM agent_configs WHERE agent_id = $1 ORDER BY version DESC`, [agentId])).rows;
  }

  /** Rollback = copy an old version forward as the newest one (history stays intact). */
  async rollback(userId: string, agentId: string, version: number) {
    await this.owned(userId, agentId);
    const r = await this.d.pool.query<{ version: number }>(
      `INSERT INTO agent_configs (agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset,
                                  context_inputs, cadence_seconds, triggers)
       SELECT agent_id, (SELECT max(version) + 1 FROM agent_configs WHERE agent_id = $1), system_prompt, model_provider, model_name,
              temperature, max_tokens, quote_asset, context_inputs, cadence_seconds, triggers
         FROM agent_configs WHERE agent_id = $1 AND version = $2
       RETURNING version`,
      [agentId, version],
    );
    if (!r.rows[0]) throw new Rejection('bad_request', `version ${version} does not exist`);
    return { version: r.rows[0].version };
  }

  /** Replace the tradable assets. Each address is registered (metadata + routes) or rejected with its code. */
  async setAssets(userId: string, agentId: string, tokens: string[]) {
    await this.owned(userId, agentId);
    const addrs = [...new Set(tokens.map((t) => getAddress(t)))];
    const registered = [];
    for (const a of addrs) registered.push((await this.d.registry.addToken(a)).token);
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agent_assets WHERE agent_id = $1', [agentId]);
      for (const a of addrs) await client.query('INSERT INTO agent_assets (agent_id, token_address) VALUES ($1, $2)', [agentId, a.toLowerCase()]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return registered;
  }

  async setRisk(userId: string, agentId: string, r: z.infer<typeof RiskInput>) {
    await this.owned(userId, agentId);
    await this.d.pool.query(
      `INSERT INTO risk_profiles (agent_id, max_position_pct, max_exposure_pct, max_daily_loss_pct, max_trades_per_day, max_slippage_bps)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id) DO UPDATE SET max_position_pct = EXCLUDED.max_position_pct, max_exposure_pct = EXCLUDED.max_exposure_pct,
         max_daily_loss_pct = EXCLUDED.max_daily_loss_pct, max_trades_per_day = EXCLUDED.max_trades_per_day, max_slippage_bps = EXCLUDED.max_slippage_bps`,
      [agentId, r.maxPositionPct, r.maxExposurePct, r.maxDailyLossPct, r.maxTradesPerDay, r.maxSlippageBps],
    );
  }

  /** Default TP/SL for new positions (architecture §3.10). Existing default guards follow on the next fill. */
  async setTpSl(userId: string, agentId: string, t: z.infer<typeof TpSlInput>) {
    await this.owned(userId, agentId);
    await this.d.pool.query(
      `INSERT INTO tp_sl_defaults (agent_id, sl_enabled, sl_mode, sl_value, tp_enabled, tp_mode, tp_value, deviation_timeout_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id) DO UPDATE SET sl_enabled = EXCLUDED.sl_enabled, sl_mode = EXCLUDED.sl_mode, sl_value = EXCLUDED.sl_value,
         tp_enabled = EXCLUDED.tp_enabled, tp_mode = EXCLUDED.tp_mode, tp_value = EXCLUDED.tp_value,
         deviation_timeout_seconds = EXCLUDED.deviation_timeout_seconds`,
      [agentId, t.stopLoss !== null, t.stopLoss?.mode ?? null, t.stopLoss?.value ?? null, t.takeProfit !== null, t.takeProfit?.mode ?? null, t.takeProfit?.value ?? null, t.deviationTimeoutSeconds],
    );
  }

  /** Per-position override; null removes that guard. The AI never reaches this path (architecture §3.10). */
  async setGuardOverride(userId: string, agentId: string, positionId: string, o: z.infer<typeof GuardOverrideInput>) {
    await this.owned(userId, agentId);
    const p = await this.d.pool.query<{ avg_entry_price: string }>(`SELECT avg_entry_price FROM positions WHERE id = $1 AND agent_id = $2 AND qty > 0`, [positionId, agentId]);
    if (!p.rows[0]) throw new Rejection('bad_request', 'no open position with that id');
    const avg = Number(p.rows[0].avg_entry_price);
    for (const [type, lvl] of [['stop_loss', o.stopLoss], ['take_profit', o.takeProfit]] as const) {
      if (lvl === undefined) continue;
      if (lvl === null) {
        await this.d.pool.query(`UPDATE guards SET state = 'cancelled' WHERE position_id = $1 AND type = $2 AND state = 'armed'`, [positionId, type]);
        continue;
      }
      const trigger = lvl.mode === 'price' ? lvl.value : type === 'stop_loss' ? avg * (1 - lvl.value / 100) : avg * (1 + lvl.value / 100);
      if (type === 'stop_loss' && lvl.mode === 'pct' && lvl.value >= 100) throw new Rejection('bad_request', 'stop loss pct must be below 100');
      await this.d.pool.query(
        `INSERT INTO guards (position_id, type, mode, value, trigger_price, set_by, state) VALUES ($1, $2, $3, $4, $5, 'user_override', 'armed')
         ON CONFLICT (position_id, type) DO UPDATE SET mode = EXCLUDED.mode, value = EXCLUDED.value, trigger_price = EXCLUDED.trigger_price,
           set_by = 'user_override', state = 'armed', first_triggered_at = NULL, attempts = 0, last_rejection_code = NULL`,
        [positionId, type, lvl.mode, lvl.value, trigger],
      );
    }
  }

  async setStatus(userId: string, agentId: string, action: z.infer<typeof StatusInput>['action']) {
    const a = await this.owned(userId, agentId);
    const to = { activate: 'active', resume: 'active', pause: 'paused', retire: 'retired' }[action];
    const from: Record<string, string[]> = { activate: ['draft', 'paused'], resume: ['paused'], pause: ['active'], retire: ['draft', 'active', 'paused'] };
    if (!from[action]!.includes(a.status)) throw new Rejection('bad_request', `cannot ${action} an agent that is ${a.status}`);
    if (to === 'active') {
      const ready = await this.d.pool.query<{ cfg: boolean; assets: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM agent_configs WHERE agent_id = $1) AS cfg, EXISTS (SELECT 1 FROM agent_assets WHERE agent_id = $1) AS assets`,
        [agentId],
      );
      if (!ready.rows[0]!.cfg) throw new Rejection('bad_request', 'set a config before activating');
      if (!ready.rows[0]!.assets) throw new Rejection('bad_request', 'pick at least one asset before activating');
    }
    await this.d.pool.query('UPDATE agents SET status = $2 WHERE id = $1', [agentId, to]);
    return { status: to };
  }

  async setMode(userId: string, agentId: string, mode: 'paper' | 'live') {
    await this.owned(userId, agentId);
    await this.d.pool.query('UPDATE agents SET mode = $2 WHERE id = $1', [agentId, mode]);
  }

  /** Paper cash in the quote asset (whole units). */
  async fundPaper(userId: string, agentId: string, amount: string, setBalance: (agentId: string, quote: Address, raw: bigint) => Promise<void>) {
    await this.owned(userId, agentId);
    const q = await this.d.pool.query<{ quote_asset: string; decimals: number }>(
      `SELECT c.quote_asset, t.decimals FROM agent_configs c JOIN tokens t ON t.address = c.quote_asset WHERE c.agent_id = $1 ORDER BY c.version DESC LIMIT 1`,
      [agentId],
    );
    if (!q.rows[0]) throw new Rejection('bad_request', 'set a config (quote asset) first');
    await setBalance(agentId, getAddress(q.rows[0].quote_asset), parseUnits(amount, q.rows[0].decimals));
  }

  async decisions(userId: string, agentId: string, limit: number) {
    await this.owned(userId, agentId);
    const r = await this.d.pool.query(
      `SELECT d.id, d.created_at, d.mode, d.origin, d.action, d.token_address, d.size, d.rationale, d.thesis, d.confidence, d.model, d.tokens_used,
              x.code AS rejection_code, x.message AS rejection_message, f.amount_in AS paper_in, f.amount_out AS paper_out
         FROM decisions d LEFT JOIN rejections x ON x.decision_id = d.id LEFT JOIN paper_fills f ON f.decision_id = d.id
        WHERE d.agent_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
      [agentId, Math.min(Math.max(limit, 1), 200)],
    );
    return r.rows;
  }

  async positions(userId: string, agentId: string) {
    await this.owned(userId, agentId);
    const r = await this.d.pool.query(
      `SELECT p.id, p.mode, p.token_address, t.symbol, t.decimals, p.qty, p.avg_entry_price,
              (SELECT price FROM market_snapshots s WHERE s.token_address = p.token_address ORDER BY ts DESC LIMIT 1) AS price_usdg,
              COALESCE((SELECT json_agg(json_build_object('id', g.id, 'type', g.type, 'mode', g.mode, 'value', g.value, 'trigger', g.trigger_price,
                        'setBy', g.set_by, 'state', g.state, 'lastRejection', g.last_rejection_code)) FROM guards g WHERE g.position_id = p.id AND g.state = 'armed'), '[]') AS guards
         FROM positions p JOIN tokens t ON t.address = p.token_address
        WHERE p.agent_id = $1 AND p.qty > 0 ORDER BY p.mode, t.symbol`,
      [agentId],
    );
    return r.rows;
  }

  async executions(userId: string, agentId: string, limit: number) {
    await this.owned(userId, agentId);
    const r = await this.d.pool.query(
      `SELECT e.created_at, e.kind, e.channel, e.status, e.tx_hash, e.nonce, e.amount_in, e.amount_out, e.gas_used, e.block, e.error_code
         FROM executions e JOIN decisions d ON d.id = e.decision_id WHERE d.agent_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
      [agentId, Math.min(Math.max(limit, 1), 200)],
    );
    return r.rows;
  }
}
