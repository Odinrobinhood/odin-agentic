import { sanitizeLabel } from '@odin/shared';

/** Payload strings may carry on-chain labels; keep them short and printable in every channel. */
const s = (v: unknown, max = 80) => sanitizeLabel(typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v), max);
const short = (a: unknown) => {
  const t = s(a, 42);
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? `${t.slice(0, 6)}…${t.slice(-4)}` : t;
};

/** Plain-text message for an alert event (no markup: nothing in it is interpreted by the channel). */
export function formatAlert(source: string, payload: Record<string, unknown>): string {
  const p = payload;
  const mode = p.mode === 'paper' ? ' [paper]' : '';
  switch (p.event) {
    case 'guard_fired':
      return `${p.type === 'stop_loss' ? 'Stop loss' : 'Take profit'} executed${mode}: sold ${short(p.token)} at ${Number(p.price).toFixed(4)} (trigger ${Number(p.trigger).toFixed(4)}).`;
    case 'guard_exit_failed':
      return `${p.type === 'stop_loss' ? 'Stop loss' : 'Take profit'} for ${short(p.token)} could not execute (${s(p.code)}): ${s(p.message, 160)}. It stays armed and will retry (attempt ${s(p.attempt)}).`;
    case 'close_all': {
      const tokens = Array.isArray(p.tokens) ? (p.tokens as { token: unknown; ok: boolean; code?: unknown }[]) : [];
      const failed = tokens.filter((t) => !t.ok);
      return failed.length === 0
        ? `Close all positions${mode}: ${tokens.length} position(s) closed.`
        : `Close all positions${mode}: ${tokens.length - failed.length}/${tokens.length} closed; not closed: ${failed.map((t) => `${short(t.token)} (${s(t.code)})`).join(', ')}. You can retry.`;
    }
    case 'trade_executed':
      return `Trade executed${mode}: ${s(p.action)} ${short(p.token)}. In ${s(p.amountIn)}, out ${s(p.amountOut)} (raw units).`;
    case 'agent_paused':
      return `Agent paused after repeated errors: ${s(p.error, 200)}. Take-profit / stop-loss keep running.`;
    case 'rule_alert': {
      const spec = (p.spec ?? {}) as Record<string, unknown>;
      const d = (p.detail ?? {}) as Record<string, unknown>;
      const what: Record<string, string> = {
        price_above: `price ${Number(d.price).toFixed(4)} is at or above ${s(spec.price)}`,
        price_below: `price ${Number(d.price).toFixed(4)} is at or below ${s(spec.price)}`,
        change_pct: `moved ${Number(d.change_pct).toFixed(2)}% in ${s(spec.minutes)} min`,
        volume_above: `volume ${Number(d.volume).toFixed(4)} over ${s(spec.minutes)} min is above ${s(spec.amount)}`,
        liquidity_below: `pool liquidity ${s(d.liquidity)} fell below ${s(spec.liquidity)}`,
        large_transfer: `${s(d.count)} transfer(s) of at least ${s(spec.amount)}`,
        wallet_activity: `${s(d.count)} new transfer(s)`,
      };
      return `Alert: ${short(spec.token ?? spec.pool ?? spec.address)} ${what[String(p.condition)] ?? s(p.condition)}.`;
    }
    case 'ai_signal':
      return `AI signal: ${short(p.token)} ${s(p.direction)} (confidence ${Math.round(Number(p.confidence) * 100)}%). ${s(p.rationale, 240)}`;
    case 'low_gas':
      return `Low gas: agent wallet ${short(p.wallet)} has ${(Number(p.balanceWei) / 1e18).toFixed(6)} ETH on Robinhood Chain. Top up native ETH so trades, take-profit and stop-loss can execute.`;
    case 'ops_stuck_transactions':
      return `[ops] ${s(p.pending)} transaction(s) stuck in signed/broadcast after reconciliation.`;
    case 'ops_nonce_drift':
      return `[ops] Nonce drift on ${short(p.wallet)}: chain ${s(p.chainNonce)} vs recorded ${s(p.recorded)} (drift ${s(p.drift)}).`;
    case 'ops_scheduler_lag':
      return `[ops] ${s(p.overdueAgents)} active agent(s) overdue by more than ${s(p.overdueSeconds)}s.`;
    case 'ops_llm_errors':
      return `[ops] LLM failures: ${s(p.failed)}/${s(p.total)} agent decisions in ${s(p.windowMinutes)} min.`;
    case 'ops_indexer_lag':
      return `[ops] Chain indexer is ${s(p.lagBlocks)} blocks behind the head.`;
    case 'ops_stale_prices':
      return `[ops] Market snapshots are stale (${s(p.ageSeconds)}s old).`;
    case 'ops_service_down':
      return `[ops] Service ${s(p.service)} is unhealthy: ${s(p.detail, 200)}`;
    case 'ops_check_failed':
      return `[ops] Watchdog check ${s(p.check)} failed: ${s(p.error, 200)}`;
    case 'test':
      return 'Test notification from Odin Agentic.';
    default:
      return `${s(source)}: ${s(p.event ?? 'event')}`;
  }
}
