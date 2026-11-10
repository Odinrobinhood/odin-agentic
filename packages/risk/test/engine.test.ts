import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { decodePath, encodePath, reversePath } from '@odin/shared';
import { RiskEngine, type RiskConfig } from '../src/engine.ts';
import type { BalanceReader, RiskChain, RiskStore } from '../src/ports.ts';
import { NO_LIMITS, type AgentRiskContext, type Mode, type RiskApproved, type RiskIntent, type RiskRejected } from '../src/types.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const USDG = addr(0x2001); // quote, 6 decimals
const WETH = addr(0x2002);
const TSLA = addr(0x3001); // stock token, 18 decimals, $250
const MEME = addr(0x3002); // 18 decimals, $0.5 via WETH
const OTHER = addr(0x3003); // not an agent asset
const WALLET = addr(0xa11ce);
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-09T12:00:00Z');
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

const TSLA_ROUTE = encodePath([TSLA, USDG], [3000]);
const MEME_ROUTE = encodePath([MEME, WETH, USDG], [10000, 500]);

class FakeStore implements RiskStore {
  ctx: AgentRiskContext | null = null;
  routes = new Map<string, Hex>();
  trades = 0;
  lastExclude: string | undefined;
  baselines = new Map<string, number>();
  async loadAgent(id: string) {
    return this.ctx && this.ctx.agentId === id ? this.ctx : null;
  }
  async route(token: Address, quote: Address) {
    return this.routes.get(`${token}-${quote}`) ?? null;
  }
  async tradesToday(_a: string, _m: Mode, _d: Date, exclude?: string) {
    this.lastExclude = exclude;
    return this.trades;
  }
  async dayBaseline(agentId: string, mode: Mode, day: string, nav: number) {
    const k = `${agentId}-${mode}-${day}`;
    if (!this.baselines.has(k)) this.baselines.set(k, nav);
    return this.baselines.get(k)!;
  }
}

class FakeChain implements RiskChain {
  /** whole USDG per whole token */
  prices = new Map<Address, number>([
    [TSLA, 250],
    [MEME, 0.5],
  ]);
  referee = new Map<Address, number | null>();
  paused = new Set<Address>();
  fail = false;
  midCalls = 0;
  decimals = new Map<Address, number>([
    [USDG, 6],
    [WETH, 18],
    [TSLA, 18],
    [MEME, 18],
  ]);
  /** raw out per raw in along a path, using only the endpoints' USDG prices */
  private rawRate(path: Hex) {
    const { tokens } = decodePath(path);
    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;
    const usd = (t: Address) => (t === USDG ? 1 : this.prices.get(t)!);
    const whole = usd(first) / usd(last);
    return whole * 10 ** (this.decimals.get(last)! - this.decimals.get(first)!);
  }
  async midRate(path: Hex) {
    if (this.fail) throw new Error('rpc down\nstack');
    this.midCalls++;
    return this.rawRate(path);
  }
  async quoteExactInput(path: Hex, amountIn: bigint) {
    // 0.3% fee, no impact
    return BigInt(Math.floor(Number(amountIn) * this.rawRate(path) * 0.997));
  }
  async refereePrice(token: Address) {
    return this.referee.has(token) ? this.referee.get(token)! : null;
  }
  async isPaused(t: Address) {
    return this.paused.has(t);
  }
}

class FakeBalances implements BalanceReader {
  bal = new Map<Address, bigint>();
  eth = 10n ** 16n;
  async token(_c: AgentRiskContext, t: Address) {
    return this.bal.get(t) ?? 0n;
  }
  async native() {
    return this.eth;
  }
}

const config: RiskConfig = { usdg: USDG, weth: WETH, gasReserveWei: 10n ** 15n, defaultSlippageBps: 100, priceToleranceBps: 300 };

let store: FakeStore;
let chain: FakeChain;
let live: FakeBalances;
let paper: FakeBalances;
let now: Date;
let engine: RiskEngine;

function ctx(over: Partial<AgentRiskContext> = {}): AgentRiskContext {
  return {
    agentId: AGENT_ID,
    status: 'active',
    wallet: WALLET,
    quoteAsset: USDG,
    assets: new Set([TSLA, MEME]),
    held: { live: new Set([TSLA]), paper: new Set() },
    stockTokens: new Set([TSLA]),
    decimals: new Map(chain.decimals),
    profile: { ...NO_LIMITS },
    ...over,
  };
}

const buy = (value: string, over: Partial<RiskIntent> = {}): RiskIntent => ({
  agentId: AGENT_ID,
  mode: 'live',
  origin: 'agent',
  action: 'buy',
  token: TSLA,
  size: { type: 'quote_amount', value },
  ...over,
});
const sell = (size: RiskIntent['size'], over: Partial<RiskIntent> = {}): RiskIntent => ({
  agentId: AGENT_ID,
  mode: 'live',
  origin: 'agent',
  action: 'sell',
  token: TSLA,
  size,
  ...over,
});

function approved(r: Awaited<ReturnType<RiskEngine['evaluate']>>): RiskApproved {
  if (!r.ok) throw new Error(`expected approval, got ${r.code}: ${r.message}`);
  return r;
}
function rejected(r: Awaited<ReturnType<RiskEngine['evaluate']>>): RiskRejected {
  if (r.ok) throw new Error('expected rejection');
  return r;
}

beforeEach(() => {
  store = new FakeStore();
  chain = new FakeChain();
  live = new FakeBalances();
  paper = new FakeBalances();
  now = NOW;
  store.ctx = ctx();
  store.routes.set(`${TSLA}-${USDG}`, TSLA_ROUTE);
  store.routes.set(`${MEME}-${USDG}`, MEME_ROUTE);
  live.bal.set(USDG, 1_000n * E6); // $1000 cash
  live.bal.set(TSLA, 2n * E18); // $500 of TSLA
  engine = new RiskEngine({ config, store, chain, balances: { live, paper }, now: () => now });
});

describe('happy paths', () => {
  it('buys along the reversed route with amountOutMin from default slippage', async () => {
    const r = approved(await engine.evaluate(buy('100')));
    expect(r.tokenIn).toBe(USDG);
    expect(r.tokenOut).toBe(TSLA);
    expect(r.path).toBe(reversePath(TSLA_ROUTE));
    expect(r.amountIn).toBe(100n * E6);
    expect(r.slippageBps).toBe(100);
    expect(r.amountOutMin).toBe((r.expectedOut * 9900n) / 10000n);
    expect(r.poolPrice).toBeCloseTo(250);
    expect(r.refereePrice).toBeNull();
  });

  it('sells a fraction of the balance', async () => {
    const r = approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '0.5' })));
    expect(r.path).toBe(TSLA_ROUTE);
    expect(r.amountIn).toBe(E18);
  });

  it('sells a quote amount converted at the pool price', async () => {
    const r = approved(await engine.evaluate(sell({ type: 'quote_amount', value: '250' })));
    expect(Number(r.amountIn) / 1e18).toBeCloseTo(1, 9);
  });

  it('routes multi-hop tokens and uses the user slippage', async () => {
    live.bal.set(MEME, 1000n * E18);
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxSlippageBps: 50 } });
    const r = approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { token: MEME })));
    expect(decodePath(r.path).tokens).toEqual([MEME, WETH, USDG]);
    expect(r.slippageBps).toBe(50);
    expect(r.amountOutMin).toBe((r.expectedOut * 9950n) / 10000n);
  });
});

describe('agent state', () => {
  it('rejects unknown, retired and non-active agents', async () => {
    store.ctx = null;
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('unknown_agent');
    store.ctx = ctx({ status: 'retired' });
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard' }))).code).toBe('agent_retired');
    store.ctx = ctx({ status: 'paused' });
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('agent_not_active');
  });

  it('rejects agents whose quote asset is not USDG or WETH, on every origin', async () => {
    store.ctx = ctx({ quoteAsset: MEME, assets: new Set([TSLA]) });
    expect(rejected(await engine.evaluate(buy('1')))).toMatchObject({ code: 'quote_not_allowed', check: 0 });
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard' }))).code).toBe('quote_not_allowed');
  });

  it('lets guards and user exits sell for paused agents', async () => {
    store.ctx = ctx({ status: 'paused' });
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard' })));
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'user_close' })));
  });

  it('refuses buys from guards and guard timing on agent intents', async () => {
    expect(rejected(await engine.evaluate(buy('1', { origin: 'guard' }))).code).toBe('bad_request');
    const r = await engine.evaluate(buy('1', { guard: { firstTriggeredAt: NOW, deviationTimeoutSeconds: 0 } }));
    expect(rejected(r).code).toBe('bad_request');
  });
});

describe('check 1 — token & route', () => {
  it('rejects tokens outside the agent assets and the quote asset itself', async () => {
    expect(rejected(await engine.evaluate(buy('1', { token: OTHER }))).code).toBe('token_not_allowed');
    expect(rejected(await engine.evaluate(buy('1', { token: USDG }))).code).toBe('token_not_allowed');
  });

  describe('exits of a held token removed from assets', () => {
    const exit = (origin: RiskIntent['origin'], mode: Mode = 'live') => sell({ type: 'fraction_of_position', value: '1' }, { origin, mode });
    beforeEach(() => {
      store.ctx = ctx({ assets: new Set([MEME]) }); // TSLA removed, still held live
    });

    it('lets guard and user exits sell it', async () => {
      const r = approved(await engine.evaluate(exit('guard')));
      expect(r).toMatchObject({ tokenIn: TSLA, tokenOut: USDG, amountIn: 2n * E18 });
      approved(await engine.evaluate(exit('user_close')));
    });

    it('never lets the agent trade it, in either direction', async () => {
      expect(rejected(await engine.evaluate(exit('agent'))).code).toBe('token_not_allowed');
      expect(rejected(await engine.evaluate(buy('1'))).code).toBe('token_not_allowed');
    });

    it('is scoped to the mode the position is held in', async () => {
      paper.bal.set(TSLA, E18);
      expect(rejected(await engine.evaluate(exit('guard', 'paper'))).code).toBe('token_not_allowed');
      store.ctx = ctx({ assets: new Set([MEME]), held: { live: new Set(), paper: new Set([TSLA]) } });
      approved(await engine.evaluate(exit('guard', 'paper')));
      expect(rejected(await engine.evaluate(exit('guard', 'live'))).code).toBe('token_not_allowed');
    });

    it('still applies Stock Token status checks', async () => {
      chain.paused.add(TSLA);
      expect(rejected(await engine.evaluate(exit('guard'))).code).toBe('token_paused');
    });
  });

  it('rejects tokens without a route', async () => {
    store.routes.delete(`${TSLA}-${USDG}`);
    const r = rejected(await engine.evaluate(buy('1')));
    expect(r).toMatchObject({ code: 'no_pool', check: 1 });
  });

  it('rejects a stored route whose endpoints do not match', async () => {
    store.routes.set(`${TSLA}-${USDG}`, encodePath([MEME, USDG], [3000]));
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('internal_error');
  });

  it('checks the pause state of stock tokens (paused() or tokenPaused())', async () => {
    chain.paused.add(TSLA);
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard' }))).code).toBe('token_paused');
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('token_paused');
  });
});

describe('check 2 — balance', () => {
  it('rejects sizes above the balance', async () => {
    expect(rejected(await engine.evaluate(buy('1000.000001'))).code).toBe('insufficient_balance');
    expect(rejected(await engine.evaluate(sell({ type: 'quote_amount', value: '501' })))).toMatchObject({ code: 'insufficient_balance', check: 2 });
  });

  it('rejects malformed or zero sizes without rounding', async () => {
    for (const v of ['0', '-1', '1e3', 'abc', '1.0000001', '']) {
      expect(rejected(await engine.evaluate(buy(v))).code, v).toBe('amount_invalid');
    }
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1.5' }))).code).toBe('amount_invalid');
    expect(rejected(await engine.evaluate(buy('1', { size: { type: 'fraction_of_position', value: '0.5' } }))).code).toBe('amount_invalid');
  });

  it('rejects selling a token the wallet does not hold', async () => {
    live.bal.delete(TSLA);
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }))).code).toBe('insufficient_balance');
  });

  it('keeps a gas reserve in live mode only', async () => {
    live.eth = 10n ** 14n;
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('insufficient_gas');
    paper.bal.set(USDG, 10n * E6);
    paper.eth = 0n;
    approved(await engine.evaluate(buy('1', { mode: 'paper' })));
  });

  it('reads paper balances in paper mode', async () => {
    expect(rejected(await engine.evaluate(buy('1', { mode: 'paper' }))).code).toBe('insufficient_balance');
  });
});

describe('check 3 — user limits', () => {
  // NAV = $1000 cash + $500 TSLA = $1500
  it('enforces max position per token', async () => {
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxPositionPct: 40 } });
    approved(await engine.evaluate(buy('100'))); // (500+100)/1500 = 40%
    const r = rejected(await engine.evaluate(buy('101')));
    expect(r).toMatchObject({ code: 'exceeds_position_limit', check: 3 });
  });

  it('enforces max total exposure', async () => {
    live.bal.set(MEME, 400n * E18); // +$200 → NAV 1700, exposure 700
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxExposurePct: 50 } });
    approved(await engine.evaluate(buy('150'))); // 850/1700 = 50%
    expect(rejected(await engine.evaluate(buy('151'))).code).toBe('exceeds_exposure_limit');
  });

  it('position/exposure limits never block sells', async () => {
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxPositionPct: 1, maxExposurePct: 1 } });
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' })));
  });

  it('enforces max trades per day, excluding the decision itself', async () => {
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxTradesPerDay: 3 } });
    store.trades = 2;
    approved(await engine.evaluate(buy('1', { decisionId: 'd-1' })));
    expect(store.lastExclude).toBe('d-1');
    store.trades = 3;
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }))).code).toBe('exceeds_trades_per_day');
  });

  it('enforces max daily loss on buys against the first NAV of the UTC day', async () => {
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxDailyLossPct: 10 } });
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '0.1' }))); // baseline 1500
    chain.prices.set(TSLA, 0); // TSLA position → $0: NAV 1000, −33%
    expect(rejected(await engine.evaluate(buy('1'))).code).toBe('exceeds_daily_loss');
    chain.prices.set(TSLA, 250);
    now = new Date('2026-11-10T00:00:01Z'); // new day, new baseline
    chain.prices.set(MEME, 0.5);
    approved(await engine.evaluate(buy('1')));
  });

  it('skips every user limit for guard and user exits', async () => {
    store.ctx = ctx({ profile: { maxPositionPct: 0, maxExposurePct: 0, maxDailyLossPct: 0, maxTradesPerDay: 0, maxSlippageBps: null } });
    store.trades = 99;
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard' })));
    approved(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'user_close' })));
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }))).code).toBe('exceeds_trades_per_day');
  });

  it('does not touch NAV when no limit is enabled', async () => {
    approved(await engine.evaluate(buy('1')));
    expect(chain.midCalls).toBe(1); // only the price-sanity read
  });
});

describe('check 4 — slippage', () => {
  it('rejects a 100% slippage setting instead of sending amountOutMin = 0', async () => {
    store.ctx = ctx({ profile: { ...NO_LIMITS, maxSlippageBps: 10_000 } });
    expect(rejected(await engine.evaluate(buy('1')))).toMatchObject({ code: 'min_out_zero', check: 4 });
  });
});

describe('check 5 — price sanity', () => {
  it('passes within tolerance and reports the deviation', async () => {
    chain.referee.set(TSLA, 245);
    const r = approved(await engine.evaluate(buy('1')));
    expect(r.deviationBps).toBeCloseTo((5 / 245) * 10_000);
  });

  it('rejects agent trades when the pool deviates from the referee', async () => {
    chain.referee.set(TSLA, 200);
    expect(rejected(await engine.evaluate(buy('1')))).toMatchObject({ code: 'price_deviation', check: 5 });
  });

  it('guards hold during the deviation timeout and sell after it', async () => {
    chain.referee.set(TSLA, 200);
    const g = (seconds: number, sinceMs: number) =>
      sell({ type: 'fraction_of_position', value: '1' }, { origin: 'guard', guard: { firstTriggeredAt: new Date(NOW.getTime() - sinceMs), deviationTimeoutSeconds: seconds } });
    expect(rejected(await engine.evaluate(g(300, 299_000))).code).toBe('price_deviation');
    const r = approved(await engine.evaluate(g(300, 300_000)));
    expect(r.overrides).toEqual(['price_deviation_timeout']);
    expect(r.amountOutMin).toBe((r.expectedOut * 9900n) / 10000n); // still bounded by slippage
    approved(await engine.evaluate(g(0, 0))); // 0 = sell regardless
  });

  it('user exits never override a deviation', async () => {
    chain.referee.set(TSLA, 200);
    expect(rejected(await engine.evaluate(sell({ type: 'fraction_of_position', value: '1' }, { origin: 'user_close' }))).code).toBe('price_deviation');
  });
});

describe('failures', () => {
  it('fails closed with chain_read_failed and the check it was on', async () => {
    chain.fail = true;
    const r = rejected(await engine.evaluate(buy('1')));
    expect(r).toMatchObject({ code: 'chain_read_failed', check: 5, message: 'rpc down' });
  });
});
