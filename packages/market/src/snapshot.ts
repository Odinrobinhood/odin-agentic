import type { Address } from 'viem';
import type { MarketChain, PoolState } from './chain.ts';
import type { OraclePrices } from './oracle.ts';
import { pathMid } from './price.ts';
import type { MarketStore, SnapshotRow, StoredRoute } from './store.ts';

export function minuteFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/**
 * Minute snapshot (architecture §3.6): USDG mid price of every token with a route, read from the pools
 * of its stored route. Tokens routed only to WETH are priced through WETH's own USDG price.
 * oracle_price: the Chainlink reference price in USDG where a verified, fresh feed exists (else null).
 */
export async function takeSnapshot(
  chain: MarketChain,
  store: MarketStore,
  cfg: { usdg: Address; weth: Address },
  now: Date = new Date(),
  oracle?: OraclePrices,
): Promise<{ rows: SnapshotRow[]; failed: Address[] }> {
  const ts = minuteFloor(now);
  const tokens = new Map((await store.listTokens()).map((t) => [t.address, t]));
  const routes = await store.routes();
  const byToken = new Map<Address, StoredRoute[]>();
  for (const r of routes) byToken.set(r.token, [...(byToken.get(r.token) ?? []), r]);

  const failed: Address[] = [];
  const mid = async (r: StoredRoute): Promise<{ price: number; first: PoolState }> => {
    const hops = await Promise.all(
      r.fees.map(async (fee, i) => {
        const p = await chain.pool(r.tokens[i]!, r.tokens[i + 1]!, fee);
        if (!p) throw new Error(`pool vanished on ${r.path}`);
        return { pool: p, tokenIn: r.tokens[i]! };
      }),
    );
    const dIn = tokens.get(r.token)?.decimals;
    const dOut = tokens.get(r.quote)?.decimals;
    if (dIn === undefined || dOut === undefined) throw new Error('decimals unknown');
    return { price: pathMid(hops, dIn, dOut), first: hops[0]!.pool };
  };

  const rows: SnapshotRow[] = [];
  let wethUsdg: number | null = null;
  const wethRoute = byToken.get(cfg.weth)?.find((r) => r.quote === cfg.usdg);
  if (wethRoute) {
    try {
      const m = await mid(wethRoute);
      wethUsdg = m.price;
      rows.push({ ts, token: cfg.weth, pool: m.first.pool, feeTier: m.first.fee, price: m.price, oraclePrice: null });
    } catch {
      failed.push(cfg.weth);
    }
  }

  for (const [token, rs] of byToken) {
    // USDG is the unit of account; WETH was priced above
    if (token === cfg.weth || token === cfg.usdg) continue;
    try {
      const toUsdg = rs.find((r) => r.quote === cfg.usdg);
      if (toUsdg) {
        const m = await mid(toUsdg);
        rows.push({ ts, token, pool: m.first.pool, feeTier: m.first.fee, price: m.price, oraclePrice: null });
        continue;
      }
      const toWeth = rs.find((r) => r.quote === cfg.weth);
      if (toWeth && wethUsdg !== null) {
        const m = await mid(toWeth);
        rows.push({ ts, token, pool: m.first.pool, feeTier: m.first.fee, price: m.price * wethUsdg, oraclePrice: null });
      }
    } catch {
      failed.push(token);
    }
  }
  if (oracle && rows.length) {
    // reference prices are informational: a failed oracle read never blocks the market snapshot
    const ref = await oracle(rows.map((r) => r.token)).catch(() => new Map<Address, number>());
    for (const r of rows) r.oraclePrice = ref.get(r.token) ?? null;
  }
  await store.insertSnapshots(rows);
  return { rows, failed };
}
