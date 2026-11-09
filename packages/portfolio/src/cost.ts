/**
 * Average-cost accounting over a wallet's indexed transfers of one token (architecture §3.15).
 * Every inflow is acquired at the USDG price at that time; every outflow realizes PnL against the running
 * average cost. If any inflow has no price, cost basis becomes unknown (null) rather than zero.
 */
export type Flow = { direction: 'in' | 'out'; amount: number; priceUsdg: number | null };

export type CostResult = { qty: number; costBasis: number | null; realizedPnl: number | null };

export function averageCost(flows: Flow[]): CostResult {
  let qty = 0;
  let cost: number | null = 0;
  let realized: number | null = 0;
  for (const f of flows) {
    if (f.amount <= 0) continue;
    if (f.direction === 'in') {
      qty += f.amount;
      cost = cost === null || f.priceUsdg === null ? null : cost + f.amount * f.priceUsdg;
    } else {
      const sold = Math.min(f.amount, qty);
      const avg = cost === null || qty === 0 ? null : cost / qty;
      realized = realized === null || avg === null || f.priceUsdg === null ? null : realized + sold * (f.priceUsdg - avg);
      if (cost !== null && avg !== null) cost -= sold * avg;
      qty -= sold;
      if (qty <= 1e-18) {
        qty = 0;
        if (cost !== null) cost = 0;
      }
    }
  }
  return { qty, costBasis: cost, realizedPnl: realized };
}
