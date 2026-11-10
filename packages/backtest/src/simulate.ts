import type { Address } from 'viem';
import type { AssetInfo, DecideResult, DecisionContext } from '@odin/decision';

/** One price point of a token in quote units (whole quote per whole token) with the pool fee at that time. */
export type PricePoint = { ts: number; price: number; feeTier: number };

export type BacktestInput = {
  agentId: string;
  userId: string;
  configVersion: number;
  mandate: string;
  model: string;
  maxTokens: number;
  cadenceSeconds: number;
  contextInputs: { candles?: { period_minutes: number; count: number }; history?: number };
  quote: AssetInfo;
  assets: AssetInfo[];
  /** Price series per asset, in QUOTE units, ascending by ts (ms). */
  prices: Map<Address, PricePoint[]>;
  tpSl: { sl: { mode: 'pct' | 'price'; value: number } | null; tp: { mode: 'pct' | 'price'; value: number } | null };
  from: number;
  to: number;
  initialCapital: number;
};

export type Trade = { ts: string; origin: 'agent' | 'stop_loss' | 'take_profit'; action: 'buy' | 'sell'; token: Address; qty: number; price: number; quoteAmount: number; fee: number };
export type BacktestResult = {
  ticks: number;
  decisions: { buy: number; sell: number; hold: number; failed: number; rejected: number };
  trades: Trade[];
  equity: { ts: string; nav: number }[];
  finalNav: number;
  returnPct: number;
  maxDrawdownPct: number;
  tokensUsed: number;
  assumptions: string[];
};

export const MAX_TICKS = 300;
const MINUTE = 60_000;

/** Latest point at or before `ts` (binary search). Never looks ahead. */
export function priceAt(series: PricePoint[] | undefined, ts: number): PricePoint | null {
  if (!series || series.length === 0 || series[0]!.ts > ts) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid]!.ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return series[lo]!;
}

function candles(series: PricePoint[] | undefined, ts: number, periodMin: number, count: number) {
  if (!series) return [];
  const period = periodMin * MINUTE;
  const start = Math.floor(ts / period) * period - (count - 1) * period;
  const out: { t: string; o: number; h: number; l: number; c: number }[] = [];
  for (const p of series) {
    if (p.ts < start || p.ts > ts) continue;
    const b = Math.floor(p.ts / period) * period;
    const last = out.at(-1);
    if (last && Date.parse(last.t) === b) {
      last.h = Math.max(last.h, p.price);
      last.l = Math.min(last.l, p.price);
      last.c = p.price;
    } else out.push({ t: new Date(b).toISOString(), o: p.price, h: p.price, l: p.price, c: p.price });
  }
  return out;
}

/**
 * Replay a config against historical snapshots (architecture §3.4). The model sees only data up to each
 * tick; fills are simulated at the snapshot price with the pool fee (no price impact: historical depth
 * is not recorded); TP/SL are checked every minute between ticks. An LLM outage aborts the run instead
 * of silently producing a "hold everything" result.
 */
export async function runBacktest(input: BacktestInput, decide: (ctx: DecisionContext) => Promise<DecideResult>, onProgress?: (pct: number) => Promise<void>): Promise<BacktestResult> {
  const step = input.cadenceSeconds * 1000;
  const tickTimes: number[] = [];
  for (let t = input.from; t <= input.to; t += step) tickTimes.push(t);
  if (tickTimes.length > MAX_TICKS) throw new Error(`window needs ${tickTimes.length} ticks; the limit is ${MAX_TICKS} (shorten the window or raise the cadence)`);

  let cash = input.initialCapital;
  const holdings = new Map<Address, { qty: number; avg: number }>();
  const trades: Trade[] = [];
  const equity: { ts: string; nav: number }[] = [];
  const history: unknown[] = [];
  const counts = { buy: 0, sell: 0, hold: 0, failed: 0, rejected: 0 };
  let tokensUsed = 0;

  const nav = (ts: number) => {
    let v = cash;
    for (const [t, h] of holdings) v += h.qty * (priceAt(input.prices.get(t), ts)?.price ?? h.avg);
    return v;
  };
  const sellAll = (token: Address, ts: number, origin: Trade['origin']) => {
    const h = holdings.get(token);
    const p = priceAt(input.prices.get(token), ts);
    if (!h || !p || h.qty <= 0) return;
    const gross = h.qty * p.price;
    const fee = gross * (p.feeTier / 1e6);
    cash += gross - fee;
    trades.push({ ts: new Date(ts).toISOString(), origin, action: 'sell', token, qty: h.qty, price: p.price, quoteAmount: gross - fee, fee });
    holdings.delete(token);
  };
  const guardsHit = (ts: number) => {
    for (const [token, h] of [...holdings]) {
      const p = priceAt(input.prices.get(token), ts);
      if (!p) continue;
      const realizable = p.price * (1 - p.feeTier / 1e6);
      const sl = input.tpSl.sl ? (input.tpSl.sl.mode === 'pct' ? h.avg * (1 - input.tpSl.sl.value / 100) : input.tpSl.sl.value) : null;
      const tp = input.tpSl.tp ? (input.tpSl.tp.mode === 'pct' ? h.avg * (1 + input.tpSl.tp.value / 100) : input.tpSl.tp.value) : null;
      if (sl !== null && realizable <= sl) sellAll(token, ts, 'stop_loss');
      else if (tp !== null && realizable >= tp) sellAll(token, ts, 'take_profit');
    }
  };

  let lastMinute = input.from;
  for (let i = 0; i < tickTimes.length; i++) {
    const t = tickTimes[i]!;
    // TP/SL every minute since the previous tick (guards run independently of the model)
    for (let m = lastMinute + MINUTE; m <= t; m += MINUTE) guardsHit(m);
    lastMinute = t;

    const ci = input.contextInputs;
    const ctx: DecisionContext = {
      agentId: input.agentId,
      userId: input.userId,
      configVersion: input.configVersion,
      mandate: input.mandate,
      model: input.model,
      maxTokens: input.maxTokens,
      mode: 'paper',
      quote: input.quote,
      assets: input.assets,
      snapshotTs: new Date(t),
      data: {
        prices_in_quote: Object.fromEntries(input.assets.map((a) => [a.address, priceAt(input.prices.get(a.address), t)?.price ?? null])),
        ...(ci.candles && ci.candles.count > 0 ? { candles: Object.fromEntries(input.assets.map((a) => [a.address, candles(input.prices.get(a.address), t, ci.candles!.period_minutes, ci.candles!.count)])) } : {}),
        balances: { [input.quote.address]: cash.toString(), ...Object.fromEntries([...holdings].map(([k, h]) => [k, h.qty.toString()])) },
        positions: [...holdings].map(([token, h]) => ({ token, qty: h.qty.toString(), avg_entry_price_quote: h.avg })),
        recent_decisions: history.slice(-(ci.history ?? 5)),
      },
    };
    const r = await decide(ctx);
    tokensUsed += r.tokensUsed;
    if (!r.ok) {
      if (r.reason === 'provider_error' || r.reason === 'budget_exhausted') throw new Error(`LLM unavailable at tick ${i + 1}: ${r.message}`);
      counts.failed++;
      history.push({ at: new Date(t).toISOString(), action: 'hold', rejection: r.reason });
    } else {
      const d = r.decision;
      counts[d.action]++;
      let rejection: string | null = null;
      if (d.action !== 'hold' && d.token && d.size) {
        const token = d.token as Address;
        const p = priceAt(input.prices.get(token), t);
        if (!p) rejection = 'no_price';
        else if (d.action === 'buy') {
          const spend = Number(d.size.value);
          if (!(spend > 0) || spend > cash) rejection = 'insufficient_balance';
          else {
            const fee = spend * (p.feeTier / 1e6);
            const qty = (spend - fee) / p.price;
            const h = holdings.get(token) ?? { qty: 0, avg: 0 };
            holdings.set(token, { qty: h.qty + qty, avg: (h.qty * h.avg + spend) / (h.qty + qty) });
            cash -= spend;
            trades.push({ ts: new Date(t).toISOString(), origin: 'agent', action: 'buy', token, qty, price: p.price, quoteAmount: spend, fee });
          }
        } else {
          const h = holdings.get(token);
          const qty = !h ? 0 : d.size.type === 'fraction_of_position' ? h.qty * Math.min(1, Number(d.size.value)) : Math.min(h.qty, Number(d.size.value) / p.price);
          if (!h || !(qty > 0)) rejection = 'insufficient_balance';
          else {
            const gross = qty * p.price;
            const fee = gross * (p.feeTier / 1e6);
            cash += gross - fee;
            const left = h.qty - qty;
            if (left <= 1e-12) holdings.delete(token);
            else holdings.set(token, { qty: left, avg: h.avg });
            trades.push({ ts: new Date(t).toISOString(), origin: 'agent', action: 'sell', token, qty, price: p.price, quoteAmount: gross - fee, fee });
          }
        }
      }
      if (rejection) counts.rejected++;
      history.push({ at: new Date(t).toISOString(), action: d.action, token: d.token, size: d.size, rationale: d.rationale, ...(rejection ? { rejection } : {}) });
    }
    equity.push({ ts: new Date(t).toISOString(), nav: nav(t) });
    if (onProgress && (i % 5 === 0 || i === tickTimes.length - 1)) await onProgress(Math.round(((i + 1) / tickTimes.length) * 100));
  }

  const finalNav = equity.at(-1)?.nav ?? input.initialCapital;
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.nav);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - e.nav) / peak) * 100);
  }
  return {
    ticks: tickTimes.length,
    decisions: counts,
    trades,
    equity,
    finalNav,
    returnPct: ((finalNav - input.initialCapital) / input.initialCapital) * 100,
    maxDrawdownPct: maxDd,
    tokensUsed,
    assumptions: [
      'Fills at the minute snapshot mid price with the pool fee; price impact and slippage are not modelled.',
      'The model sees only data up to each tick (no lookahead).',
      'Take-profit / stop-loss use the current defaults and are checked every minute at the realizable price.',
      'Assets are the agent\'s current assets; optional risk limits are not applied.',
    ],
  };
}
