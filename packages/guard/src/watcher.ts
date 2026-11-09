import type { Address, Hex } from 'viem';
import type { SwapJob, SwapOutcome } from '@odin/executor';
import type { RiskIntent, RiskResult } from '@odin/risk';
import type { RuntimeStore } from '@odin/runtime';
import type { ArmedGuard, GuardStore, WatchedPosition } from './store.ts';

export type GuardDeps = {
  store: GuardStore;
  runtime: Pick<RuntimeStore, 'loadAgent' | 'insertDecision' | 'insertRejection' | 'recordPaperFill' | 'applyFill'>;
  /** QuoterV2 output for selling `amountIn` along `path` (fees and price impact included). */
  quote: (path: Hex, amountIn: bigint) => Promise<bigint>;
  risk: { evaluate(intent: RiskIntent): Promise<RiskResult> };
  /** Executor wired to the signer's guard channel. */
  executor: { executeSwap(job: SwapJob): Promise<SwapOutcome> };
};

export type GuardEvent =
  | { kind: 'fired'; guardId: string; positionId: string; type: ArmedGuard['type']; price: number; amountIn: bigint; amountOut: bigint }
  | { kind: 'failed'; guardId: string; positionId: string; type: ArmedGuard['type']; price: number; code: string; message: string }
  | { kind: 'reset'; guardId: string; positionId: string }
  | { kind: 'unpriced'; positionId: string; reason: string };

/**
 * Guard Watcher (architecture §3.10). Each pass prices every guarded position at its REALIZABLE exit price
 * — the quoter output for selling the whole position along its route, so pool fees and price impact are
 * included — and fires a triggered stop loss / take profit as a guard-origin sell through the same Risk
 * Engine and Signer (guard channel) as everything else. A failed exit stays armed and is retried next pass.
 */
export class GuardWatcher {
  private readonly d: GuardDeps;
  private readonly busy = new Set<string>();

  constructor(deps: GuardDeps) {
    this.d = deps;
  }

  async checkOnce(): Promise<GuardEvent[]> {
    const events: GuardEvent[] = [];
    const positions = await this.d.store.watched();
    await Promise.all(
      positions.map(async (p) => {
        if (this.busy.has(p.positionId)) return; // previous exit for this position still in flight
        this.busy.add(p.positionId);
        try {
          events.push(...(await this.checkPosition(p)));
        } catch (e) {
          events.push({ kind: 'unpriced', positionId: p.positionId, reason: (e as Error).message.split('\n')[0] ?? 'error' });
        } finally {
          this.busy.delete(p.positionId);
        }
      }),
    );
    return events;
  }

  /** Whole quote units per whole token if the entire position were sold now. */
  async realizablePrice(p: WatchedPosition): Promise<number | null> {
    const path = await this.d.store.route(p.token, p.quote);
    if (!path) return null;
    const out = await this.d.quote(path, p.qty);
    if (out <= 0n) return null;
    return Number(out) / 10 ** p.quoteDecimals / (Number(p.qty) / 10 ** p.tokenDecimals);
  }

  private async checkPosition(p: WatchedPosition): Promise<GuardEvent[]> {
    const price = await this.realizablePrice(p);
    if (price === null) return [{ kind: 'unpriced', positionId: p.positionId, reason: 'no route or zero quote' }];

    const hit = (g: ArmedGuard) => (g.type === 'stop_loss' ? price <= g.triggerPrice : price >= g.triggerPrice);
    const events: GuardEvent[] = [];
    for (const g of p.guards) {
      if (!hit(g) && g.firstTriggeredAt) {
        await this.d.store.clearTrigger(g.id);
        events.push({ kind: 'reset', guardId: g.id, positionId: p.positionId });
      }
    }
    // stop loss wins if both somehow trigger (protection first)
    const fire = p.guards.filter(hit).sort((a) => (a.type === 'stop_loss' ? -1 : 1))[0];
    if (!fire) return events;
    events.push(await this.fire(p, fire, price));
    return events;
  }

  private async fire(p: WatchedPosition, g: ArmedGuard, price: number): Promise<GuardEvent> {
    const firstTriggeredAt = await this.d.store.markTriggered(g.id);
    const base = { guardId: g.id, positionId: p.positionId, type: g.type, price };
    const decisionId = await this.d.runtime.insertDecision({
      agentId: p.agentId, configVersion: null, snapshotId: null, mode: p.mode, origin: 'guard', action: 'sell', token: p.token,
      size: { type: 'fraction_of_position', value: '1' },
      rationale: `${g.type} at realizable ${price} (trigger ${g.triggerPrice})`,
      thesis: null, confidence: null, model: null, promptHash: null, responseHash: null, tokensUsed: 0,
    });

    const failed = async (code: string, message: string): Promise<GuardEvent> => {
      await this.d.runtime.insertRejection(decisionId, code, message);
      await this.d.store.recordFailure(g.id, code);
      // every failed exit is notified, never silent (architecture §3.7)
      await this.d.store.alert(g.id, { event: 'guard_exit_failed', type: g.type, agentId: p.agentId, token: p.token, price, trigger: g.triggerPrice, code, message, attempt: g.attempts + 1 });
      return { kind: 'failed', ...base, code, message };
    };

    const out = await this.sellAll(p, 'guard', decisionId, { firstTriggeredAt, deviationTimeoutSeconds: p.deviationTimeoutSeconds }, () => this.d.store.markFired(g.id));
    if (!out.ok) return failed(out.code, out.message);
    await this.d.store.alert(g.id, { event: 'guard_fired', type: g.type, agentId: p.agentId, token: p.token, price, trigger: g.triggerPrice, mode: p.mode, amountIn: out.amountIn.toString(), amountOut: out.amountOut.toString(), overrides: out.overrides });
    return { kind: 'fired', ...base, amountIn: out.amountIn, amountOut: out.amountOut };
  }

  /**
   * "Close all positions" (architecture §10): requested through the API, executed here on the guard
   * channel. One user_close sell per held token; each token's outcome is reported (a price deviation is
   * not overridden for user closes, so that token comes back as price_deviation and can be retried).
   */
  async processCloseRequests(): Promise<CloseResult[]> {
    const results: CloseResult[] = [];
    for (const req of await this.d.store.claimCloseRequests()) {
      const tokens: CloseResult['tokens'] = [];
      for (const p of await this.d.store.openPositions(req.agentId, req.mode)) {
        if (this.busy.has(p.positionId)) {
          tokens.push({ token: p.token, ok: false, code: 'bad_request', message: 'an exit for this position is already in flight' });
          continue;
        }
        this.busy.add(p.positionId);
        try {
          const decisionId = await this.d.runtime.insertDecision({
            agentId: p.agentId, configVersion: null, snapshotId: null, mode: p.mode, origin: 'user_close', action: 'sell', token: p.token,
            size: { type: 'fraction_of_position', value: '1' }, rationale: 'user requested close all positions',
            thesis: null, confidence: null, model: null, promptHash: null, responseHash: null, tokensUsed: 0,
          });
          const out = await this.sellAll(p, 'user_close', decisionId);
          if (out.ok) tokens.push({ token: p.token, ok: true, amountIn: out.amountIn.toString(), amountOut: out.amountOut.toString() });
          else {
            await this.d.runtime.insertRejection(decisionId, out.code, out.message);
            tokens.push({ token: p.token, ok: false, code: out.code, message: out.message });
          }
        } finally {
          this.busy.delete(p.positionId);
        }
      }
      const status = tokens.every((t) => t.ok) ? 'done' : 'partial';
      await this.d.store.finishCloseRequest(req.id, status, { tokens });
      await this.d.store.alert(req.id, { event: 'close_all', agentId: req.agentId, mode: req.mode, status, tokens });
      results.push({ requestId: req.id, agentId: req.agentId, status, tokens });
    }
    return results;
  }

  /** Sell the whole position through the Risk Engine and, live, the executor on the guard channel; then book it. */
  private async sellAll(
    p: WatchedPosition,
    origin: 'guard' | 'user_close',
    decisionId: string,
    guard?: { firstTriggeredAt: Date; deviationTimeoutSeconds: number },
    beforeBooking?: () => Promise<void>,
  ): Promise<{ ok: true; amountIn: bigint; amountOut: bigint; overrides: string[] } | { ok: false; code: string; message: string }> {
    const risk = await this.d.risk.evaluate({
      agentId: p.agentId, decisionId, mode: p.mode, origin, action: 'sell', token: p.token,
      size: { type: 'fraction_of_position', value: '1' },
      ...(guard ? { guard } : {}),
    });
    if (!risk.ok) return { ok: false, code: risk.code, message: risk.message };

    const agent = await this.d.runtime.loadAgent(p.agentId);
    if (!agent) return { ok: false, code: 'unknown_agent', message: 'agent has no wallet or config' };
    // the token may have been removed from the agent's assets while still held: keep its decimals for the books
    const assets = agent.assets.some((a) => a.address === p.token)
      ? agent.assets
      : [...agent.assets, { address: p.token, symbol: '', decimals: p.tokenDecimals, isStockToken: false }];
    const runtimeAgent = { ...agent, mode: p.mode, assets };

    let amountIn = risk.amountIn;
    let amountOut = risk.expectedOut;
    if (p.mode === 'live') {
      const ex = await this.d.executor.executeSwap({ decisionId, agentId: p.agentId, wallet: agent.wallet, channel: 'guard', path: risk.path, amountIn: risk.amountIn, amountOutMin: risk.amountOutMin });
      if (!ex.ok) return { ok: false, code: ex.code, message: ex.message };
      amountIn = ex.amountIn;
      amountOut = ex.amountOut;
    } else {
      await this.d.runtime.recordPaperFill(decisionId, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
    }
    await beforeBooking?.();
    // positions drop to zero here, which cancels the position's remaining armed guards
    await this.d.runtime.applyFill(runtimeAgent, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
    return { ok: true, amountIn, amountOut, overrides: risk.overrides };
  }
}

export type CloseResult = {
  requestId: string;
  agentId: string;
  status: 'done' | 'partial';
  tokens: { token: Address; ok: boolean; code?: string; message?: string; amountIn?: string; amountOut?: string }[];
};
