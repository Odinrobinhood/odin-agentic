import { formatUnits, type Address } from 'viem';
import type { DecideResult, DecisionContext } from '@odin/decision';
import type { SwapJob, SwapOutcome } from '@odin/executor';
import type { BalanceReader, Mode, RiskIntent, RiskResult, AgentRiskContext } from '@odin/risk';
import type { RejectionCode } from '@odin/shared';
import type { AgentRuntimeState, RuntimeStore } from './types.ts';

export type TickDeps = {
  store: RuntimeStore;
  decide: (ctx: DecisionContext) => Promise<DecideResult>;
  risk: { evaluate(intent: RiskIntent): Promise<RiskResult> };
  executor: { executeSwap(job: SwapJob): Promise<SwapOutcome> };
  balances: Record<Mode, BalanceReader>;
};

export type TickResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'hold'; decisionId: string; code?: RejectionCode }
  | { outcome: 'rejected'; decisionId: string; code: RejectionCode; message: string }
  | { outcome: 'filled'; decisionId: string; mode: Mode; amountIn: bigint; amountOut: bigint };

const LLM_CODES: Record<Exclude<DecideResult, { ok: true }>['reason'], RejectionCode> = {
  budget_exhausted: 'llm_budget_exhausted',
  model_refused: 'llm_refused',
  invalid_output: 'llm_invalid_output',
  provider_error: 'llm_unavailable',
};

/**
 * One tick for one agent (architecture §4):
 *  1. load snapshot + positions + balances   2. decide → store decision   3. hold → done
 *  4. risk → reject → store code             5–6. approve/swap via signer + executor (live) or paper fill
 *  7. update positions                       8. arm TP/SL guards          9. notify
 */
export async function runTick(deps: TickDeps, agentId: string): Promise<TickResult> {
  const agent = await deps.store.loadAgent(agentId);
  if (!agent) return { outcome: 'skipped', reason: 'agent has no wallet or config' };
  if (agent.status !== 'active') return { outcome: 'skipped', reason: `agent is ${agent.status}` };

  // ── 1. context ─────────────────────────────────────────────────────────────
  const ci = agent.config.contextInputs;
  const tokens = [agent.quote.address, ...agent.assets.map((a) => a.address)];
  const [market, positions, history, balances] = await Promise.all([
    deps.store.market(tokens, ci.candles),
    deps.store.positions(agent.agentId, agent.mode),
    deps.store.recentDecisions(agent.agentId, ci.history ?? 5),
    readBalances(deps.balances[agent.mode], agent),
  ]);
  const dec = new Map([agent.quote, ...agent.assets].map((a) => [a.address, a.decimals]));
  const ctx: DecisionContext = {
    agentId: agent.agentId,
    userId: agent.userId,
    configVersion: agent.config.version,
    mandate: agent.config.mandate,
    model: agent.config.modelName,
    maxTokens: agent.config.maxTokens,
    mode: agent.mode,
    quote: agent.quote,
    assets: agent.assets,
    snapshotTs: market.snapshotTs,
    data: {
      prices_usdg: Object.fromEntries(market.pricesUsdg),
      ...(market.candles.size ? { candles: Object.fromEntries(market.candles) } : {}),
      balances: Object.fromEntries([...balances].map(([t, v]) => [t, formatUnits(v, dec.get(t) ?? 18)])),
      positions: positions
        .filter((p) => p.token !== agent.quote.address)
        .map((p) => ({ token: p.token, qty: formatUnits(p.qty, dec.get(p.token) ?? 18), avg_entry_price_quote: p.avgEntryPrice })),
      recent_decisions: history,
    },
  };

  // ── 2. decide ──────────────────────────────────────────────────────────────
  const r = await deps.decide(ctx);
  const common = {
    agentId: agent.agentId,
    configVersion: agent.config.version,
    snapshotId: market.snapshotId,
    mode: agent.mode,
    origin: 'agent' as const,
    model: r.model,
    promptHash: r.promptHash,
    responseHash: r.responseHash,
    tokensUsed: r.tokensUsed,
  };
  if (!r.ok) {
    // a failed decision is a hold, recorded with its reason; guards keep running regardless
    const id = await deps.store.insertDecision({ ...common, action: 'hold', token: null, size: null, rationale: null, thesis: null, confidence: null });
    await deps.store.insertRejection(id, LLM_CODES[r.reason], r.message);
    return { outcome: 'hold', decisionId: id, code: LLM_CODES[r.reason] };
  }
  const d = r.decision;
  const decisionId = await deps.store.insertDecision({
    ...common,
    action: d.action,
    token: (d.token as Address | null) ?? null,
    size: d.size,
    rationale: d.rationale,
    thesis: d.thesis,
    confidence: d.confidence,
  });

  // ── 3. hold ────────────────────────────────────────────────────────────────
  if (d.action === 'hold' || !d.token || !d.size) return { outcome: 'hold', decisionId };

  // ── 4. risk ────────────────────────────────────────────────────────────────
  const risk = await deps.risk.evaluate({ agentId: agent.agentId, decisionId, mode: agent.mode, origin: 'agent', action: d.action, token: d.token as Address, size: d.size });
  if (!risk.ok) {
    await deps.store.insertRejection(decisionId, risk.code, risk.message);
    return { outcome: 'rejected', decisionId, code: risk.code, message: risk.message };
  }

  // ── 5–6. execute ───────────────────────────────────────────────────────────
  let amountIn: bigint;
  let amountOut: bigint;
  if (agent.mode === 'live') {
    const ex = await deps.executor.executeSwap({ decisionId, agentId: agent.agentId, wallet: agent.wallet, channel: 'agent', path: risk.path, amountIn: risk.amountIn, amountOutMin: risk.amountOutMin });
    if (!ex.ok) {
      await deps.store.insertRejection(decisionId, ex.code, ex.message);
      return { outcome: 'rejected', decisionId, code: ex.code, message: ex.message };
    }
    amountIn = ex.amountIn;
    amountOut = ex.amountOut;
  } else {
    // paper: identical up to the Risk Engine, filled at the quoter's realizable output (§3.4)
    amountIn = risk.amountIn;
    amountOut = risk.expectedOut;
    await deps.store.recordPaperFill(decisionId, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
  }

  // ── 7–8. positions + guards ────────────────────────────────────────────────
  await deps.store.applyFill(agent, { tokenIn: risk.tokenIn, tokenOut: risk.tokenOut, amountIn, amountOut });
  // ── 9. notify ──────────────────────────────────────────────────────────────
  await deps.store.alert(decisionId, { event: 'trade_executed', agentId: agent.agentId, mode: agent.mode, action: d.action, token: d.token, amountIn: amountIn.toString(), amountOut: amountOut.toString() });
  return { outcome: 'filled', decisionId, mode: agent.mode, amountIn, amountOut };
}

async function readBalances(reader: BalanceReader, agent: AgentRuntimeState): Promise<Map<Address, bigint>> {
  const ctx = { agentId: agent.agentId, wallet: agent.wallet } as AgentRiskContext;
  const out = new Map<Address, bigint>();
  for (const a of [agent.quote, ...agent.assets]) out.set(a.address, await reader.token(ctx, a.address).catch(() => 0n));
  return out;
}
