import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import type { SwapJob, SwapOutcome } from '@odin/executor';
import type { RiskIntent, RiskResult } from '@odin/risk';
import type { AgentRuntimeState, DecisionRow, Fill } from '@odin/runtime';
import { GuardWatcher, type GuardDeps } from '../src/watcher.ts';
import type { ArmedGuard, GuardStore, WatchedPosition } from '../src/store.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const USDG = addr(0x2001);
const WETH = addr(0x2002);
const WALLET = addr(0xa11ce);
const PATH = '0xpath' as Hex;
const T0 = new Date('2026-11-09T12:00:00Z');

class FakeGuards implements GuardStore {
  positions: WatchedPosition[] = [];
  fired: string[] = [];
  failures: { id: string; code: string }[] = [];
  cleared: string[] = [];
  alerts: Record<string, unknown>[] = [];
  async watched() {
    return this.positions;
  }
  async route() {
    return PATH;
  }
  async markTriggered(id: string) {
    const g = this.positions.flatMap((p) => p.guards).find((x) => x.id === id)!;
    g.firstTriggeredAt ??= T0;
    return g.firstTriggeredAt;
  }
  async clearTrigger(id: string) {
    this.cleared.push(id);
  }
  async recordFailure(id: string, code: string) {
    this.failures.push({ id, code });
  }
  async markFired(id: string) {
    this.fired.push(id);
  }
  async alert(_id: string, payload: Record<string, unknown>) {
    this.alerts.push(payload);
  }
}

const guards = (sl: number, tp: number, over: Partial<ArmedGuard> = {}): ArmedGuard[] => [
  { id: 'sl', type: 'stop_loss', triggerPrice: sl, firstTriggeredAt: null, attempts: 0, ...over },
  { id: 'tp', type: 'take_profit', triggerPrice: tp, firstTriggeredAt: null, attempts: 0 },
];
const position = (over: Partial<WatchedPosition> = {}): WatchedPosition => ({
  positionId: 'p1', agentId: 'a1', mode: 'paper', token: WETH, tokenDecimals: 18, quote: USDG, quoteDecimals: 6,
  qty: 10n ** 18n, deviationTimeoutSeconds: 300, guards: guards(1900, 2300), ...over,
});

let store: FakeGuards;
let quoteOut: bigint;
let intents: RiskIntent[];
let jobs: SwapJob[];
let riskResult: RiskResult;
let swap: SwapOutcome;
let decisions: DecisionRow[];
let rejections: string[];
let fills: { agent: AgentRuntimeState; fill: Fill }[];
let watcher: GuardWatcher;

beforeEach(() => {
  store = new FakeGuards();
  quoteOut = 2_000_000_000n; // 2000 USDG for 1 WETH
  intents = [];
  jobs = [];
  decisions = [];
  rejections = [];
  fills = [];
  riskResult = { ok: true, tokenIn: WETH, tokenOut: USDG, path: PATH, amountIn: 10n ** 18n, expectedOut: 1_890_000_000n, amountOutMin: 1_870_000_000n, slippageBps: 100, poolPrice: 1890, refereePrice: null, deviationBps: null, overrides: [] };
  swap = { ok: true, swap: { kind: 'swap', status: 'confirmed' }, amountIn: 10n ** 18n, amountOut: 1_885_000_000n };
  const runtime: GuardDeps['runtime'] = {
    loadAgent: async () => ({ agentId: 'a1', userId: 'u', status: 'paused', mode: 'live', wallet: WALLET, config: { version: 1, mandate: '', modelName: 'm', maxTokens: 1, contextInputs: {}, cadenceSeconds: 60 }, quote: { address: USDG, symbol: 'USDG', decimals: 6, isStockToken: false }, assets: [{ address: WETH, symbol: 'WETH', decimals: 18, isStockToken: false }], tpSl: null }),
    insertDecision: async (d) => (decisions.push(d), `d${decisions.length}`),
    insertRejection: async (_id, code) => void rejections.push(code),
    recordPaperFill: async () => {},
    applyFill: async (agent, fill) => void fills.push({ agent, fill }),
  };
  watcher = new GuardWatcher({
    store,
    runtime,
    quote: async () => quoteOut,
    risk: { evaluate: async (i) => (intents.push(i), riskResult) },
    executor: { executeSwap: async (j) => (jobs.push(j), swap) },
  });
});

describe('GuardWatcher', () => {
  it('does nothing while the realizable price is between the triggers', async () => {
    store.positions = [position()];
    expect(await watcher.checkOnce()).toEqual([]);
    expect(intents).toHaveLength(0);
  });

  it('fires a stop loss at the realizable price as a guard-origin full sell (paper)', async () => {
    quoteOut = 1_890_000_000n; // 1890 < 1900
    store.positions = [position()];
    const [e] = await watcher.checkOnce();
    expect(e).toMatchObject({ kind: 'fired', guardId: 'sl', type: 'stop_loss', price: 1890 });
    expect(intents[0]).toEqual({
      agentId: 'a1', decisionId: 'd1', mode: 'paper', origin: 'guard', action: 'sell', token: WETH,
      size: { type: 'fraction_of_position', value: '1' }, guard: { firstTriggeredAt: T0, deviationTimeoutSeconds: 300 },
    });
    expect(decisions[0]).toMatchObject({ origin: 'guard', action: 'sell', model: null });
    expect(jobs).toHaveLength(0);
    expect(store.fired).toEqual(['sl']);
    expect(fills[0]!.agent.mode).toBe('paper');
    expect(store.alerts[0]).toMatchObject({ event: 'guard_fired', type: 'stop_loss' });
  });

  it('live: exits through the executor on the guard channel, also for a paused agent', async () => {
    quoteOut = 2_400_000_000n; // take profit
    store.positions = [position({ mode: 'live' })];
    const [e] = await watcher.checkOnce();
    expect(e).toMatchObject({ kind: 'fired', guardId: 'tp', amountOut: 1_885_000_000n });
    expect(jobs[0]).toMatchObject({ channel: 'guard', wallet: WALLET, path: PATH, amountIn: 10n ** 18n, amountOutMin: 1_870_000_000n });
  });

  it('a refused exit stays armed, is recorded with its code, and is notified on every attempt', async () => {
    quoteOut = 1_000_000_000n;
    store.positions = [position({ mode: 'live' })];
    riskResult = { ok: false, code: 'price_deviation', message: 'pool off referee', check: 5 };
    await watcher.checkOnce();
    riskResult = { ok: false, code: 'insufficient_gas', message: 'no eth', check: 2 };
    await watcher.checkOnce();
    expect(store.failures).toEqual([{ id: 'sl', code: 'price_deviation' }, { id: 'sl', code: 'insufficient_gas' }]);
    expect(rejections).toEqual(['price_deviation', 'insufficient_gas']);
    expect(store.alerts.map((a) => a.event)).toEqual(['guard_exit_failed', 'guard_exit_failed']);
    expect(store.fired).toEqual([]);
    // the trigger time is kept across retries so the user's deviation timeout can elapse
    expect(intents.map((i) => i.guard?.firstTriggeredAt)).toEqual([T0, T0]);
  });

  it('a failed broadcast is a failed attempt too', async () => {
    quoteOut = 1_000_000_000n;
    store.positions = [position({ mode: 'live' })];
    swap = { ok: false, code: 'tx_reverted', message: 'reverted' };
    expect((await watcher.checkOnce())[0]).toMatchObject({ kind: 'failed', code: 'tx_reverted' });
    expect(fills).toHaveLength(0);
  });

  it('only one sell per position even if both guards are hit, and stop loss wins', async () => {
    quoteOut = 1_000_000_000n;
    store.positions = [position({ guards: guards(1900, 500) })];
    const ev = await watcher.checkOnce();
    expect(ev.filter((e) => e.kind === 'fired')).toHaveLength(1);
    expect(ev[0]).toMatchObject({ guardId: 'sl' });
    expect(intents).toHaveLength(1);
  });

  it('resets a trigger when the price moves back before the exit succeeded', async () => {
    store.positions = [position({ guards: guards(1900, 2300, { firstTriggeredAt: T0, attempts: 2 }) })];
    expect(await watcher.checkOnce()).toEqual([{ kind: 'reset', guardId: 'sl', positionId: 'p1' }]);
    expect(store.cleared).toEqual(['sl']);
  });

  it('reports an unpriceable position without firing', async () => {
    quoteOut = 0n;
    store.positions = [position()];
    expect(await watcher.checkOnce()).toEqual([{ kind: 'unpriced', positionId: 'p1', reason: 'no route or zero quote' }]);
  });
});
