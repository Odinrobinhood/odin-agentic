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
    case 'test':
      return 'Test notification from Odin Agentic.';
    default:
      return `${s(source)}: ${s(p.event ?? 'event')}`;
  }
}
