import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import type { DecideResult, DecisionContext } from '@odin/decision';
import type { SwapJob, SwapOutcome } from '@odin/executor';
import type { RiskIntent, RiskResult } from '@odin/risk';
import { guardTriggers, nextPosition } from '../src/positions.ts';
import { runTick, type TickDeps } from '../src/tick.ts';
import type { AgentRuntimeState, DecisionRow, Fill, PositionRow, RuntimeStore } from '../src/types.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const USDG = addr(0x2001);
const TSLA = addr(0x3001);
const WALLET = addr(0xa11ce);

describe('positions', () => {
  const dec = { token: 18, quote: 6 };
  it('weights average entry on buys and keeps it on partial sells', () => {
    const b1 = nextPosition(null, { tokenIn: USDG, tokenOut: TSLA, amountIn: 400_000_000n, amountOut: 10n ** 18n }, USDG, dec);
    expect(b1).toEqual({ token: TSLA, qty: 10n ** 18n, avgEntryPrice: 400 });
    const b2 = nextPosition(b1, { tokenIn: USDG, tokenOut: TSLA, amountIn: 500_000_000n, amountOut: 10n ** 18n }, USDG, dec);
    expect(b2.avgEntryPrice).toBeCloseTo(450, 9);
    const s = nextPosition(b2, { tokenIn: TSLA, tokenOut: USDG, amountIn: 10n ** 18n, amountOut: 1n }, USDG, dec);
    expect(s).toEqual({ token: TSLA, qty: 10n ** 18n, avgEntryPrice: b2.avgEntryPrice });
    expect(nextPosition(s, { tokenIn: TSLA, tokenOut: USDG, amountIn: 5n * 10n ** 18n, amountOut: 1n }, USDG, dec)).toEqual({ token: TSLA, qty: 0n, avgEntryPrice: 0 });
  });

  it('computes guard triggers from pct or absolute price', () => {
    const g = guardTriggers(400, { slEnabled: true, slMode: 'pct', slValue: 5, tpEnabled: true, tpMode: 'price', tpValue: 480 });
    expect(g).toEqual([
      { type: 'stop_loss', mode: 'pct', value: 5, trigger: 380 },
      { type: 'take_profit', mode: 'price', value: 480, trigger: 480 },
    ]);
    expect(guardTriggers(400, { slEnabled: false, slMode: null, slValue: null, tpEnabled: false, tpMode: null, tpValue: null })).toEqual([]);
  });
});

class FakeStore implements RuntimeStore {
  agent: AgentRuntimeState;
  decisions: (DecisionRow & { id: string })[] = [];
  rejections: { decisionId: string; code: string }[] = [];
  paperFills: Fill[] = [];
  fills: Fill[] = [];
  constructor(a: AgentRuntimeState) {
    this.agent = a;
  }
  async loadAgent() {
    return this.agent;
  }
  async market() {
    return { snapshotId: 42, snapshotTs: new Date(), pricesUsdg: new Map([[TSLA, 385]]), candles: new Map() };
  }
  async positions(): Promise<PositionRow[]> {
    return [];
  }
  async recentDecisions() {
    return [];
  }
  async insertDecision(d: DecisionRow) {
    const id = `d${this.decisions.length + 1}`;
    this.decisions.push({ ...d, id });
    return id;
  }
  async insertRejection(decisionId: string, code: string) {
    this.rejections.push({ decisionId, code });
  }
  async recordPaperFill(_: string, f: Fill) {
    this.paperFills.push(f);
  }
  async applyFill(_: AgentRuntimeState, f: Fill) {
    this.fills.push(f);
  }
  alerts: Record<string, unknown>[] = [];
  async alert(_id: string, p: Record<string, unknown>) {
    this.alerts.push(p);
  }
}

const agent = (over: Partial<AgentRuntimeState> = {}): AgentRuntimeState => ({
  agentId: 'a1',
  userId: 'u1',
  status: 'active',
  mode: 'paper',
  wallet: WALLET,
  config: { version: 3, mandate: 'm', modelName: 'claude-opus-5-5', maxTokens: 16000, contextInputs: {}, cadenceSeconds: 60 },
  quote: { address: USDG, symbol: 'USDG', decimals: 6, isStockToken: false },
  assets: [{ address: TSLA, symbol: 'TSLA', decimals: 18, isStockToken: true }],
  tpSl: null,
  ...over,
});

const meta = { model: 'claude-opus-5-5', promptHash: 'p', responseHash: 'r', tokensUsed: 9 };
const buy: DecideResult = { ok: true, decision: { action: 'buy', token: TSLA, size: { type: 'quote_amount', value: '100' }, rationale: 'r', thesis: { claim: 'c', horizon_ticks: 3, invalidated_if: 'x' }, confidence: 0.5 }, ...meta };
const approved: RiskResult = { ok: true, tokenIn: USDG, tokenOut: TSLA, path: '0xabc', amountIn: 100_000_000n, expectedOut: 259_000_000_000_000_000n, amountOutMin: 256_000_000_000_000_000n, slippageBps: 100, poolPrice: 385, refereePrice: null, deviationBps: null, overrides: [] };

let store: FakeStore;
let seen: { ctx?: DecisionContext; intent?: RiskIntent; job?: SwapJob };
let decideResult: DecideResult;
let riskResult: RiskResult;
let swapOutcome: SwapOutcome;
let deps: TickDeps;

beforeEach(() => {
  store = new FakeStore(agent());
  seen = {};
  decideResult = buy;
  riskResult = approved;
  swapOutcome = { ok: true, swap: { kind: 'swap', status: 'confirmed' }, amountIn: 100_000_000n, amountOut: 258_000_000_000_000_000n };
  const reader = { token: async () => 5_000_000_000n, native: async () => 0n };
  deps = {
    store,
    decide: async (c) => ((seen.ctx = c), decideResult),
    risk: { evaluate: async (i) => ((seen.intent = i), riskResult) },
    executor: { executeSwap: async (j) => ((seen.job = j), swapOutcome) },
    balances: { live: reader, paper: reader },
  };
});

describe('runTick', () => {
  it('paper: decides, passes risk with the decision id, fills at the quoter output, never touches the executor', async () => {
    const r = await runTick(deps, 'a1');
    expect(r).toMatchObject({ outcome: 'filled', mode: 'paper', amountOut: approved.expectedOut });
    expect(seen.intent).toMatchObject({ agentId: 'a1', decisionId: 'd1', mode: 'paper', origin: 'agent', action: 'buy', token: TSLA });
    expect(seen.job).toBeUndefined();
    expect(store.paperFills).toHaveLength(1);
    expect(store.fills[0]).toMatchObject({ tokenIn: USDG, tokenOut: TSLA });
    expect(store.alerts[0]).toMatchObject({ event: 'trade_executed', agentId: 'a1', mode: 'paper', action: 'buy', token: TSLA });
    expect(store.decisions[0]).toMatchObject({ configVersion: 3, snapshotId: 42, origin: 'agent', model: 'claude-opus-5-5', tokensUsed: 9 });
    expect(seen.ctx!.data).toMatchObject({ balances: { [USDG]: '5000', [TSLA]: '0.000000005' } });
  });

  it('live: hands the risk-approved path and amounts to the executor and books realized amounts', async () => {
    store.agent = agent({ mode: 'live' });
    const r = await runTick(deps, 'a1');
    expect(seen.job).toMatchObject({ decisionId: 'd1', wallet: WALLET, channel: 'agent', path: '0xabc', amountIn: approved.amountIn, amountOutMin: approved.amountOutMin });
    expect(r).toMatchObject({ outcome: 'filled', amountOut: 258_000_000_000_000_000n });
    expect(store.paperFills).toHaveLength(0);
  });

  it('records risk and executor rejections with their codes and does not update positions', async () => {
    riskResult = { ok: false, code: 'exceeds_position_limit', message: 'too big', check: 3 };
    expect(await runTick(deps, 'a1')).toMatchObject({ outcome: 'rejected', code: 'exceeds_position_limit' });
    store.agent = agent({ mode: 'live' });
    riskResult = approved;
    swapOutcome = { ok: false, code: 'insufficient_gas', message: 'no eth' };
    expect(await runTick(deps, 'a1')).toMatchObject({ outcome: 'rejected', code: 'insufficient_gas' });
    expect(store.rejections.map((x) => x.code)).toEqual(['exceeds_position_limit', 'insufficient_gas']);
    expect(store.fills).toHaveLength(0);
  });

  it('a failed decision is stored as a hold with an llm_* code; holds never reach risk', async () => {
    decideResult = { ok: false, reason: 'budget_exhausted', message: 'out', ...meta };
    expect(await runTick(deps, 'a1')).toMatchObject({ outcome: 'hold', code: 'llm_budget_exhausted' });
    decideResult = { ...buy, decision: { ...(buy as { decision: object }).decision, action: 'hold', token: null, size: null } } as DecideResult;
    expect(await runTick(deps, 'a1')).toMatchObject({ outcome: 'hold' });
    expect(seen.intent).toBeUndefined();
    expect(store.decisions.map((d) => d.action)).toEqual(['hold', 'hold']);
  });

  it('gives the model each position\'s opened_at and held_minutes (holding-time rules must not be guessed)', async () => {
    const opened = new Date(Date.now() - 25 * 60_000 - 5_000);
    store.positions = async () => [{ token: TSLA, qty: 10n ** 18n, avgEntryPrice: 380, openedAt: opened }];
    decideResult = { ...buy, decision: { ...(buy as { decision: object }).decision, action: 'hold', token: null, size: null } } as DecideResult;
    await runTick(deps, 'a1');
    expect(seen.ctx!.data).toMatchObject({ positions: [{ token: TSLA, opened_at: opened.toISOString(), held_minutes: 25 }] });
  });

  it('passes the trigger that woke the tick to the model', async () => {
    decideResult = { ...buy, decision: { ...(buy as { decision: object }).decision, action: 'hold', token: null, size: null } } as DecideResult;
    await runTick(deps, 'a1', { wake: { trigger: 0, condition: 'price_below' } });
    expect(seen.ctx!.data).toMatchObject({ woken_by_trigger: { trigger: 0, condition: 'price_below' } });
    await runTick(deps, 'a1');
    expect(seen.ctx!.data).not.toHaveProperty('woken_by_trigger');
  });

  it('skips agents that are not active', async () => {
    store.agent = agent({ status: 'paused' });
    expect(await runTick(deps, 'a1')).toEqual({ outcome: 'skipped', reason: 'agent is paused' });
  });
});
