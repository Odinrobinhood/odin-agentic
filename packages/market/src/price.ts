import type { Address } from 'viem';
import type { PoolState } from './chain.ts';

const Q96 = 2 ** 96;

/** Mid price of one hop in raw units: raw tokenOut per raw tokenIn, from slot0 (fee excluded). */
export function hopRawRate(p: PoolState, tokenIn: Address): number {
  const s = Number(p.sqrtPriceX96) / Q96;
  const price1Per0 = s * s;
  return tokenIn.toLowerCase() === p.token0.toLowerCase() ? price1Per0 : 1 / price1Per0;
}

/** Mid price along hops, in whole units of the last token per whole unit of the first. */
export function pathMid(hops: { pool: PoolState; tokenIn: Address }[], decimalsIn: number, decimalsOut: number): number {
  let raw = 1;
  for (const h of hops) raw *= hopRawRate(h.pool, h.tokenIn);
  return raw * 10 ** (decimalsIn - decimalsOut);
}

/** Realizable price for selling along the path: mid reduced by every hop's pool fee (architecture §7). */
export function realizable(mid: number, fees: number[]): number {
  return fees.reduce((p, f) => p * (1 - f / 1_000_000), mid);
}
