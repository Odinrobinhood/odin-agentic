import type { Hex } from 'viem';
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

    const risk = await this.d.risk.evaluate({
      agentId: p.agentId, decisionId, mode: p.mode, origin: 'guard', action: 'sell', token: p.token,
      size: { type: 'fraction_of_position', value: '1' },
      guard: { firstTriggeredAt, deviationTimeoutSeconds: p.deviationTimeoutSeconds },
    });
    if (!risk.ok) return failed(risk.code, risk.message);

    const agent = await this.d.runtime.loadAgent(p.agentId);
    if (!agent) return failed('unknown_agent', 'agent has no wallet or config');
    // the token may have been removed from the agent's assets while still held: keep its decimals for the books
    const assets = agent.assets.some((a) => a.address === p.token)
      ? agent.assets
      : [...agent.assets, { address: p.token, symbol: '', decimals: p.tokenDecimals, isStockToken: false }];
    const runtimeAgent = { ...agent, mode: p.mode, assets };

    let amountIn = risk.amountIn;
    let amountOut = risk.expectedOut;
    if (p.mode === 'live') {
      const ex = await this.d.executor.executeSwap({ decisionId, agentId: p.agentId, wallet: agent.wallet, channel: 'guard', path: risk.path, amountIn: risk.amountIn, amountOutMin: risk.amountOutMin });
      if (!ex.ok) return failed(ex.code, ex.message);
      amountIn = ex.amountIn;
      amountOut = ex.amountOut;
    } else {
      await this.d.runtime.recordPaperFill(decisionId, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
    }
    await this.d.store.markFired(g.id);
    // positions drop to zero here, which cancels the position's other armed guard
    await this.d.runtime.applyFill(runtimeAgent, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
    await this.d.store.alert(g.id, { event: 'guard_fired', type: g.type, agentId: p.agentId, token: p.token, price, trigger: g.triggerPrice, mode: p.mode, amountIn: amountIn.toString(), amountOut: amountOut.toString(), overrides: risk.overrides });
    return { kind: 'fired', ...base, amountIn, amountOut };
  }
}
