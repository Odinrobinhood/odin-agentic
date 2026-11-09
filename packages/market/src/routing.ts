import type { Address, Hex } from 'viem';
import { FEE_TIERS, encodePath, type FeeTier } from '@odin/shared';
import type { MarketChain, PoolState } from './chain.ts';
import { pathMid } from './price.ts';

export type Route = {
  token: Address;
  quote: Address;
  /** v3 path token → quote (sell direction), lowercase hex. */
  path: Hex;
  pools: Address[];
  fees: FeeTier[];
  hops: { pool: PoolState; tokenIn: Address; tokenOut: Address }[];
};

export type RoutingConfig = {
  usdg: Address;
  weth: Address;
  /** Probe size used to compare candidate routes, in whole quote units, per quote asset. */
  probeQuote: Map<Address, number>;
};

/** Deepest pool for a pair across all fee tiers (same pair, same price ⇒ liquidity is comparable). */
export async function deepestPool(chain: MarketChain, a: Address, b: Address): Promise<PoolState | null> {
  const pools = await Promise.all(FEE_TIERS.map((f) => chain.pool(a, b, f)));
  let best: PoolState | null = null;
  for (const p of pools) if (p && p.liquidity > 0n && (!best || p.liquidity > best.liquidity)) best = p;
  return best;
}

function build(token: Address, quote: Address, legs: { pool: PoolState; tokenIn: Address; tokenOut: Address }[]): Route {
  const tokens = [token, ...legs.map((l) => l.tokenOut)];
  return {
    token,
    quote,
    path: encodePath(tokens, legs.map((l) => l.pool.fee)).toLowerCase() as Hex,
    pools: legs.map((l) => l.pool.pool),
    fees: legs.map((l) => l.pool.fee),
    hops: legs,
  };
}

/**
 * Find the route token → quote (architecture §3.6): single hop when a direct pool exists, otherwise via
 * the other base asset (USDG/WETH are the only intermediates the signer accepts). When several candidates
 * exist, each is quoted with the same probe size and the best output wins, so depth is compared by what
 * a trade would actually receive.
 */
export async function findRoute(chain: MarketChain, cfg: RoutingConfig, token: Address, quote: Address, decimals: { token: number; quote: number }): Promise<Route | null> {
  if (token === quote) return null;
  const candidates: Route[] = [];

  const direct = await deepestPool(chain, token, quote);
  if (direct) candidates.push(build(token, quote, [{ pool: direct, tokenIn: token, tokenOut: quote }]));

  for (const mid of [cfg.usdg, cfg.weth]) {
    if (mid === token || mid === quote) continue;
    const [a, b] = await Promise.all([deepestPool(chain, token, mid), deepestPool(chain, mid, quote)]);
    if (a && b) candidates.push(build(token, quote, [{ pool: a, tokenIn: token, tokenOut: mid }, { pool: b, tokenIn: mid, tokenOut: quote }]));
  }

  if (candidates.length <= 1) return candidates[0] ?? null;

  // probe: token amount worth `probeQuote` at the first candidate's mid price
  const first = candidates[0]!;
  const mid = pathMid(first.hops, decimals.token, decimals.quote);
  const probeQuote = cfg.probeQuote.get(quote) ?? 1;
  const probeWhole = mid > 0 ? probeQuote / mid : 1;
  const probe = BigInt(Math.max(1, Math.floor(probeWhole * 10 ** decimals.token)));

  let best: { r: Route; out: bigint } | null = null;
  for (const r of candidates) {
    const out = await chain.quote(r.path, probe);
    if (out !== null && (!best || out > best.out)) best = { r, out };
  }
  return best?.r ?? first;
}
