import { createPublicClient, fallback, getAddress, http, parseAbi, type Address } from 'viem';
import type { Pool } from '@odin/db';
import { RuleSpec, evaluate, type RuleData, type TransferEvent } from './rules.ts';
import type { SignalEngine, SignalProfile } from './ai.ts';

const poolAbi = parseAbi(['function liquidity() view returns (uint128)', 'function token0() view returns (address)']);
const lc = (a: string) => a.toLowerCase();

export class PgRuleData implements RuleData {
  private readonly pool: Pool;
  private readonly c;
  private readonly token0 = new Map<string, string>();

  constructor(pool: Pool, rpcUrls: string[]) {
    this.pool = pool;
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 10_000 }))) });
  }

  async latestPrice(token: Address) {
    const r = await this.pool.query<{ price: string; ts: Date }>('SELECT price, ts FROM market_snapshots WHERE token_address = $1 ORDER BY ts DESC LIMIT 1', [lc(token)]);
    return r.rows[0] ? { price: Number(r.rows[0].price), ts: r.rows[0].ts } : null;
  }

  async priceAt(token: Address, at: Date) {
    const r = await this.pool.query<{ price: string }>(
      `SELECT price FROM market_snapshots WHERE token_address = $1 AND ts <= $2 AND ts > $2 - interval '10 minutes' ORDER BY ts DESC LIMIT 1`,
      [lc(token), at],
    );
    return r.rows[0] ? Number(r.rows[0].price) : null;
  }

  async swapVolume(token: Address, minutes: number) {
    const t = lc(token);
    const meta = await this.pool.query<{ decimals: number }>('SELECT decimals FROM tokens WHERE address = $1', [t]);
    const pools = await this.pool.query<{ pool: string }>('SELECT DISTINCT unnest(pools::text[]) AS pool FROM routes WHERE token_address = $1', [t]);
    let total = 0;
    for (const p of pools.rows) {
      let t0 = this.token0.get(p.pool);
      if (!t0) {
        t0 = lc((await this.c.readContract({ address: getAddress(p.pool), abi: poolAbi, functionName: 'token0' })) as string);
        this.token0.set(p.pool, t0);
      }
      const col = t0 === t ? 'amount0' : 'amount1';
      const v = await this.pool.query<{ v: string | null }>(`SELECT sum(abs(${col})) AS v FROM swaps WHERE pool = $1 AND block_time > now() - make_interval(mins => $2)`, [p.pool, minutes]);
      total += Number(v.rows[0]?.v ?? 0);
    }
    return total / 10 ** (meta.rows[0]?.decimals ?? 18);
  }

  async poolLiquidity(pool: Address) {
    return this.c.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' });
  }

  async indexedTo() {
    const r = await this.pool.query<{ b: string | null }>(`SELECT min(last_block) AS b FROM indexer_state WHERE stream LIKE 'transfer:%'`);
    return r.rows[0]?.b ? BigInt(r.rows[0].b) : null;
  }

  async transfers(q: { token?: Address; wallet?: Address; minAmount?: number; fromBlock: bigint; toBlock: bigint }): Promise<TransferEvent[]> {
    const r = await this.pool.query<{ block: string; tx_hash: string; token_address: string; from: string; to: string; amount: string; decimals: number }>(
      `SELECT t.block, t.tx_hash, t.token_address, t."from", t."to", t.amount, k.decimals
         FROM transfers t JOIN tokens k ON k.address = t.token_address
        WHERE t.block BETWEEN $1 AND $2
          AND ($3::text IS NULL OR t.token_address = $3)
          AND ($4::text IS NULL OR t."from" = $4 OR t."to" = $4)
          AND ($5::numeric IS NULL OR t.amount >= $5 * 10 ^ k.decimals)
        ORDER BY t.block, t.log_index LIMIT 200`,
      [q.fromBlock.toString(), q.toBlock.toString(), q.token ? lc(q.token) : null, q.wallet ? lc(q.wallet) : null, q.minAmount ?? null],
    );
    return r.rows.map((x) => ({ block: BigInt(x.block), txHash: x.tx_hash, token: getAddress(x.token_address), from: getAddress(x.from), to: getAddress(x.to), amount: Number(x.amount) / 10 ** x.decimals }));
  }
}

/** Runs rule alerts and AI signal profiles; delivers through alert_events (the Notifier). Never trades. */
export class SignalsService {
  private readonly pool: Pool;
  private readonly data: RuleData;
  private readonly engine: SignalEngine;

  constructor(deps: { pool: Pool; data: RuleData; engine: SignalEngine }) {
    this.pool = deps.pool;
    this.data = deps.data;
    this.engine = deps.engine;
  }

  async evaluateRules(): Promise<{ evaluated: number; fired: number; errors: number }> {
    const rules = await this.pool.query<{ id: string; user_id: string; condition: string; params: Record<string, unknown>; channels: string[]; cooldown_seconds: number; last_fired_at: Date | null; cursor_block: string | null }>(
      `SELECT id, user_id, condition, params, channels, cooldown_seconds, last_fired_at, cursor_block FROM rule_alerts WHERE enabled`,
    );
    let fired = 0;
    let errors = 0;
    for (const r of rules.rows) {
      try {
        const spec = RuleSpec.parse({ condition: r.condition, ...r.params });
        const ev = await evaluate(spec, this.data, r.cursor_block === null ? null : BigInt(r.cursor_block));
        // cooldown per alert so the same condition does not fire repeatedly (architecture §3.14)
        const cooling = r.last_fired_at !== null && Date.now() - r.last_fired_at.getTime() < r.cooldown_seconds * 1000;
        if (ev.fired && !cooling) {
          await this.pool.query(`INSERT INTO alert_events (source, source_id, user_id, payload) VALUES ('rule', $1, $2, $3)`, [
            r.id, r.user_id, JSON.stringify({ event: 'rule_alert', ruleId: r.id, condition: spec.condition, spec, detail: ev.detail ?? {}, channels: r.channels }),
          ]);
          fired++;
        }
        await this.pool.query(
          `UPDATE rule_alerts SET last_evaluated_at = now(), cursor_block = COALESCE($2, cursor_block), last_fired_at = CASE WHEN $3 THEN now() ELSE last_fired_at END WHERE id = $1`,
          [r.id, ev.cursor?.toString() ?? null, ev.fired && !cooling],
        );
      } catch {
        errors++;
      }
    }
    return { evaluated: rules.rowCount ?? 0, fired, errors };
  }

  /** Run due AI signal profiles (latest version of each), leased so two workers never run the same one. */
  async runProfiles(): Promise<{ ran: number; signals: number; failed: number }> {
    await this.pool.query(`INSERT INTO signal_schedule (profile_id) SELECT DISTINCT id FROM signal_profiles ON CONFLICT DO NOTHING`);
    const due = await this.pool.query<{ profile_id: string }>(
      `UPDATE signal_schedule SET lease_until = now() + interval '5 minutes'
        WHERE profile_id IN (SELECT profile_id FROM signal_schedule WHERE next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
                              ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING profile_id`,
    );
    let ran = 0;
    let made = 0;
    let failed = 0;
    for (const { profile_id } of due.rows) {
      const p = await this.pool.query<{ id: string; version: number; user_id: string; system_prompt: string; model_name: string; tokens: string[]; cadence_seconds: number; channels: string[]; enabled: boolean }>(
        `SELECT id, version, user_id, system_prompt, model_name, tokens::text[] AS tokens, cadence_seconds, channels, enabled FROM signal_profiles WHERE id = $1 ORDER BY version DESC LIMIT 1`,
        [profile_id],
      );
      const row = p.rows[0];
      let error: string | null = null;
      let cadence = 3600;
      if (row?.enabled) {
        cadence = row.cadence_seconds;
        const profile: SignalProfile = { id: row.id, version: row.version, userId: row.user_id, mandate: row.system_prompt, model: row.model_name, tokens: row.tokens.map((t) => getAddress(t)), cadenceSeconds: row.cadence_seconds, channels: row.channels };
        const run = await this.engine.run(profile, await this.marketData(profile.tokens));
        ran++;
        if (run.ok) {
          for (const s of run.signals) {
            await this.pool.query(
              `INSERT INTO signals (profile_id, profile_version, token_address, direction, rationale, thesis, confidence, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [profile.id, profile.version, lc(s.token), s.direction, s.rationale, JSON.stringify(s.thesis), s.confidence, run.model],
            );
            await this.pool.query(`INSERT INTO alert_events (source, source_id, user_id, payload) VALUES ('signal', $1, $2, $3)`, [
              profile.id, profile.userId, JSON.stringify({ event: 'ai_signal', profileId: profile.id, token: s.token, direction: s.direction, confidence: s.confidence, rationale: s.rationale.slice(0, 300), channels: profile.channels }),
            ]);
            made++;
          }
        } else {
          failed++;
          error = `${run.reason}: ${run.message}`;
        }
      }
      await this.pool.query(
        `UPDATE signal_schedule SET next_run_at = now() + make_interval(secs => GREATEST(60, $2)), lease_until = NULL, last_run_at = now(), last_error = $3 WHERE profile_id = $1`,
        [profile_id, cadence, error],
      );
    }
    return { ran, signals: made, failed };
  }

  private async marketData(tokens: Address[]) {
    const out: Record<string, unknown> = {};
    for (const t of tokens) {
      const c = await this.pool.query(
        `SELECT time_bucket('15 minutes', ts) AS t, first(price, ts)::float AS o, max(price)::float AS h, min(price)::float AS l, last(price, ts)::float AS c
           FROM market_snapshots WHERE token_address = $1 AND ts > now() - interval '4 hours' GROUP BY 1 ORDER BY 1`,
        [lc(t)],
      );
      out[t] = { candles_15m_usdg: c.rows, volume_1h: await this.data.swapVolume(t, 60) };
    }
    return out;
  }
}
