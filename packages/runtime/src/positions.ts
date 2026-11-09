import type { Address } from 'viem';
import type { Fill, TpSlDefaults } from './types.ts';

const whole = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Which side of the fill is the traded token: buys pay quote for a token, sells the reverse. */
export function fillSide(fill: Fill, quote: Address): { side: 'buy' | 'sell'; token: Address } {
  return fill.tokenIn === quote ? { side: 'buy', token: fill.tokenOut } : { side: 'sell', token: fill.tokenIn };
}

/**
 * Next position after a fill. Average entry is in whole quote units per whole token, weighted by quantity;
 * sells reduce quantity at the existing average (realized PnL is tracked by the portfolio service).
 */
export function nextPosition(
  old: { qty: bigint; avgEntryPrice: number } | null,
  fill: Fill,
  quote: Address,
  decimals: { token: number; quote: number },
): { token: Address; qty: bigint; avgEntryPrice: number } {
  const { side, token } = fillSide(fill, quote);
  const oldQty = old?.qty ?? 0n;
  const oldAvg = old?.avgEntryPrice ?? 0;
  if (side === 'buy') {
    const qty = oldQty + fill.amountOut;
    const cost = whole(oldQty, decimals.token) * oldAvg + whole(fill.amountIn, decimals.quote);
    return { token, qty, avgEntryPrice: qty > 0n ? cost / whole(qty, decimals.token) : 0 };
  }
  const qty = oldQty > fill.amountIn ? oldQty - fill.amountIn : 0n;
  return { token, qty, avgEntryPrice: qty > 0n ? oldAvg : 0 };
}

/** Guard trigger prices from the user's defaults (architecture §3.10): pct from entry, or an absolute price. */
export function guardTriggers(avgEntry: number, d: TpSlDefaults): { type: 'stop_loss' | 'take_profit'; mode: 'pct' | 'price'; value: number; trigger: number }[] {
  const out: { type: 'stop_loss' | 'take_profit'; mode: 'pct' | 'price'; value: number; trigger: number }[] = [];
  if (d.slEnabled && d.slMode && d.slValue !== null) {
    out.push({ type: 'stop_loss', mode: d.slMode, value: d.slValue, trigger: d.slMode === 'pct' ? avgEntry * (1 - d.slValue / 100) : d.slValue });
  }
  if (d.tpEnabled && d.tpMode && d.tpValue !== null) {
    out.push({ type: 'take_profit', mode: d.tpMode, value: d.tpValue, trigger: d.tpMode === 'pct' ? avgEntry * (1 + d.tpValue / 100) : d.tpValue });
  }
  return out;
}
