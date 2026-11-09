import { describe, expect, it } from 'vitest';
import { averageCost } from '../src/cost.ts';

describe('averageCost', () => {
  it('weights inflows and realizes PnL on outflows against the running average', () => {
    const r = averageCost([
      { direction: 'in', amount: 1, priceUsdg: 2000 },
      { direction: 'in', amount: 1, priceUsdg: 2200 },
      { direction: 'out', amount: 1, priceUsdg: 2300 },
    ]);
    expect(r.qty).toBe(1);
    expect(r.costBasis).toBeCloseTo(2100, 9);
    expect(r.realizedPnl).toBeCloseTo(200, 9);
  });

  it('cost basis is unknown (null), never zero, when an inflow is unpriced', () => {
    expect(averageCost([{ direction: 'in', amount: 5, priceUsdg: null }, { direction: 'in', amount: 1, priceUsdg: 10 }])).toEqual({ qty: 6, costBasis: null, realizedPnl: 0 });
  });

  it('a full exit resets cost; oversized outflows cannot go negative', () => {
    const r = averageCost([{ direction: 'in', amount: 2, priceUsdg: 1 }, { direction: 'out', amount: 3, priceUsdg: 2 }]);
    expect(r).toEqual({ qty: 0, costBasis: 0, realizedPnl: 2 });
  });
});
