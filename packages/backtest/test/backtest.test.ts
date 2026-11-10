import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import type { DecideResult, DecisionContext } from '@odin/decision';
import { MAX_TICKS, priceAt, runBacktest, type BacktestInput, type PricePoint } from '../src/simulate.ts';

const USDG = getAddress('0x' + '20'.repeat(20));
const TSLA = getAddress('0x' + '30'.repeat(20));
const T0 = Date.parse('2026-11-09T00:00:00Z');
const MIN = 60_000;

/** price per minute from a function of the minute index; fee 0.3% */
const series = (n: number, f: (i: number) => number): PricePoint[] => Array.from({ length: n }, (_, i) => ({ ts: T0 + i * MIN, price: f(i), feeTier: 3000 }));

const input = (over: Partial<BacktestInput> = {}): BacktestInput => ({
  agentId: 'a', userId: 'u', configVersion: 1, mandate: 'm', model: 'claude-opus-5-5', maxTokens: 1000,
  cadenceSeconds: 600, contextInputs: { candles: { period_minutes: 10, count: 3 }, history: 2 },
  quote: { address: USDG, symbol: 'USDG', decimals: 6, isStockToken: false },
  assets: [{ address: TSLA, symbol: 'TSLA', decimals: 18, isStockToken: true }],
  prices: new Map([[TSLA, series(61, () => 100)]]),
  tpSl: { sl: null, tp: null },
  from: T0, to: T0 + 60 * MIN, initialCapital: 1000,
  ...over,
});

const meta = { model: 'claude-opus-5-5', promptHash: 'p', responseHash: 'r', tokensUsed: 10 };
const thesis = { claim: 'c', horizon_ticks: 1, invalidated_if: 'x' };
const hold: DecideResult = { ok: true, decision: { action: 'hold', token: null, size: null, rationale: 'wait', thesis, confidence: 0.5 }, ...meta };
const buy = (v: string): DecideResult => ({ ok: true, decision: { action: 'buy', token: TSLA, size: { type: 'quote_amount', value: v }, rationale: 'r', thesis, confidence: 0.5 }, ...meta });
const sellAll: DecideResult = { ok: true, decision: { action: 'sell', token: TSLA, size: { type: 'fraction_of_position', value: '1' }, rationale: 'r', thesis, confidence: 0.5 }, ...meta };

describe('priceAt', () => {
  it('returns the latest point at or before the time, never a later one', () => {
    const s = series(5, (i) => i);
    expect(priceAt(s, T0 + 2.5 * MIN)!.price).toBe(2);
    expect(priceAt(s, T0 - 1)).toBeNull();
  });
});

describe('runBacktest', () => {
  it('ticks on the cadence, shows the model only past data, applies fees and tracks NAV', async () => {
    const prices = new Map([[TSLA, series(61, (i) => 100 + i)]]);
    const seen: DecisionContext[] = [];
    const script = [buy('500'), hold, hold, sellAll];
    const r = await runBacktest(input({ prices }), async (ctx) => (seen.push(ctx), script.shift() ?? hold));
    expect(r.ticks).toBe(7);
    // no lookahead: at each tick the model's price equals the snapshot at that time, candles end there
    for (const c of seen) {
      const t = c.snapshotTs!.getTime();
      expect((c.data.prices_in_quote as Record<string, number>)[TSLA]).toBe(100 + (t - T0) / MIN);
      const cs = (c.data.candles as Record<string, { t: string }[]>)[TSLA]!;
      expect(Date.parse(cs.at(-1)!.t)).toBeLessThanOrEqual(t);
    }
    const [b, s] = r.trades;
    expect(b).toMatchObject({ action: 'buy', price: 100, quoteAmount: 500, fee: 1.5 });
    expect(b!.qty).toBeCloseTo(498.5 / 100, 9);
    expect(s).toMatchObject({ action: 'sell', price: 130 });
    expect(s!.quoteAmount).toBeCloseTo(4.985 * 130 * 0.997, 6);
    expect(r.finalNav).toBeCloseTo(500 + 4.985 * 130 * 0.997, 6);
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.decisions).toMatchObject({ buy: 1, sell: 1, hold: 5 });
    expect(r.tokensUsed).toBe(70);
  });

  it('fires the stop loss between ticks at the realizable price', async () => {
    // buy at 100, price falls to 80 at minute 3; SL 5% must fire before the next tick at minute 10
    const prices = new Map([[TSLA, series(61, (i) => (i < 3 ? 100 : 80))]]);
    const script = [buy('1000')];
    const r = await runBacktest(input({ prices, tpSl: { sl: { mode: 'pct', value: 5 }, tp: null } }), async () => script.shift() ?? hold);
    const sl = r.trades.find((t) => t.origin === 'stop_loss')!;
    expect(sl.ts).toBe(new Date(T0 + 3 * MIN).toISOString());
    expect(r.finalNav).toBeLessThan(1000);
    expect(r.maxDrawdownPct).toBeGreaterThan(15);
  });

  it('rejects oversize buys and sells of nothing without crashing', async () => {
    const script = [buy('5000'), sellAll];
    const r = await runBacktest(input(), async () => script.shift() ?? hold);
    expect(r.decisions.rejected).toBe(2);
    expect(r.trades).toEqual([]);
    expect(r.finalNav).toBe(1000);
  });

  it('aborts when the LLM is unavailable instead of reporting an all-hold run', async () => {
    await expect(runBacktest(input(), async () => ({ ok: false, reason: 'provider_error', message: 'no key', ...meta }))).rejects.toThrow(/LLM unavailable at tick 1/);
  });

  it('refuses windows that need more model calls than the limit', async () => {
    await expect(runBacktest(input({ cadenceSeconds: 60, to: T0 + (MAX_TICKS + 5) * MIN }), async () => hold)).rejects.toThrow(/limit is/);
  });
});
