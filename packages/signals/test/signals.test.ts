import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { MemoryTokenMeter, type DecisionProvider } from '@odin/decision';
import { RuleSpec, SignalEngine, evaluate, type RuleData, type TransferEvent } from '../src/index.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const WETH = addr(0x2002);
const POOL = addr(0x9999);
const WHALE = addr(0xbeef);
const NOW = new Date('2026-11-09T12:00:00Z');

class Data implements RuleData {
  price = 2000;
  past = 1900;
  vol = 10;
  liq = 1000n;
  head: bigint | null = 500n;
  events: TransferEvent[] = [];
  async latestPrice() {
    return { price: this.price, ts: NOW };
  }
  async priceAt() {
    return this.past;
  }
  async swapVolume() {
    return this.vol;
  }
  async poolLiquidity() {
    return this.liq;
  }
  async indexedTo() {
    return this.head;
  }
  async transfers(q: { token?: Address; wallet?: Address; minAmount?: number; fromBlock: bigint; toBlock: bigint }) {
    return this.events.filter((e) => e.block >= q.fromBlock && e.block <= q.toBlock && (!q.minAmount || e.amount >= q.minAmount) && (!q.wallet || e.from === q.wallet || e.to === q.wallet));
  }
}

describe('rule alerts', () => {
  it('validates specs strictly', () => {
    expect(RuleSpec.safeParse({ condition: 'price_above', token: WETH, price: 1 }).success).toBe(true);
    expect(RuleSpec.safeParse({ condition: 'price_above', token: 'nope', price: 1 }).success).toBe(false);
    expect(RuleSpec.safeParse({ condition: 'price_above', token: WETH, price: -1 }).success).toBe(false);
    expect(RuleSpec.safeParse({ condition: 'trade', token: WETH }).success).toBe(false);
  });

  it('price, change, volume and liquidity conditions', async () => {
    const d = new Data();
    expect((await evaluate({ condition: 'price_above', token: WETH, price: 1999 }, d, null)).fired).toBe(true);
    expect((await evaluate({ condition: 'price_below', token: WETH, price: 1999 }, d, null)).fired).toBe(false);
    const ch = await evaluate({ condition: 'change_pct', token: WETH, minutes: 60, pct: 5 }, d, null);
    expect(ch.fired).toBe(true);
    expect(ch.detail!.change_pct).toBeCloseTo(5.263, 2);
    expect((await evaluate({ condition: 'volume_above', token: WETH, minutes: 60, amount: 11 }, d, null)).fired).toBe(false);
    expect((await evaluate({ condition: 'liquidity_below', pool: POOL, liquidity: '1001' }, d, null)).fired).toBe(true);
  });

  it('event rules start at the indexed head and then fire once per new event', async () => {
    const d = new Data();
    d.events = [{ block: 400n, txHash: '0x1', token: WETH, from: WHALE, to: POOL, amount: 500 }];
    const first = await evaluate({ condition: 'large_transfer', token: WETH, amount: 100 }, d, null);
    expect(first).toEqual({ fired: false, cursor: 500n }); // history is not alerted
    d.events.push({ block: 510n, txHash: '0x2', token: WETH, from: WHALE, to: POOL, amount: 250 }, { block: 520n, txHash: '0x3', token: WETH, from: POOL, to: WHALE, amount: 5 });
    d.head = 530n;
    const second = await evaluate({ condition: 'large_transfer', token: WETH, amount: 100 }, d, 500n);
    expect(second).toMatchObject({ fired: true, cursor: 530n, detail: { count: 1 } });
    const wallet = await evaluate({ condition: 'wallet_activity', address: WHALE }, d, 500n);
    expect(wallet.detail!.count).toBe(2);
    expect((await evaluate({ condition: 'wallet_activity', address: WHALE }, d, 530n)).fired).toBe(false);
  });
});

describe('AI signals', () => {
  const profile = { id: 'p', version: 1, userId: 'u', mandate: 'momentum', model: 'claude-opus-5-5', tokens: [WETH], cadenceSeconds: 3600, channels: [] };
  const provider = (text: string | null): DecisionProvider & { reqs: unknown[] } => {
    const reqs: unknown[] = [];
    return { name: 's', reqs, supports: () => true, complete: async (r) => (reqs.push(r), { text, stopReason: text === null ? 'refusal' : 'end_turn', model: 'claude-opus-5-5', tokensUsed: 50 }) };
  };
  const sig = (token: string) => ({ token, direction: 'bullish', rationale: 'r', thesis: { claim: 'c', horizon_ticks: 2, invalidated_if: 'x' }, confidence: 0.7 });

  it('returns validated signals for watched tokens only, with the signal schema', async () => {
    const p = provider(JSON.stringify({ signals: [sig(WETH.toLowerCase()), sig(addr(0xdead))] }));
    const r = await new SignalEngine({ providers: [p], meter: new MemoryTokenMeter(), dailyTokenBudget: 1e6 }).run(profile, { x: 1 }, NOW);
    expect(r).toMatchObject({ ok: true, tokensUsed: 50 });
    if (!r.ok) return;
    expect(r.signals.map((s) => s.token)).toEqual([WETH]);
    expect((p.reqs[0] as { schema: { required: string[] } }).schema.required).toEqual(['signals']);
  });

  it('reports refusals, malformed output and an exhausted budget', async () => {
    const e = (text: string | null, budget = 1e6) => new SignalEngine({ providers: [provider(text)], meter: new MemoryTokenMeter(), dailyTokenBudget: budget });
    expect(await e(null).run(profile, {}, NOW)).toMatchObject({ ok: false, reason: 'model_refused' });
    expect(await e('{"signals":[{"token":"x"}]}').run(profile, {}, NOW)).toMatchObject({ ok: false, reason: 'invalid_output' });
    expect(await e('{}', 0).run(profile, {}, NOW)).toMatchObject({ ok: false, reason: 'budget_exhausted' });
  });
});
