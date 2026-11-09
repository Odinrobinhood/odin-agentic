import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { Rejection, decodePath, type FeeTier } from '@odin/shared';
import type { MarketChain, PoolState, TokenMeta } from '../src/chain.ts';
import { deepestPool, findRoute, type RoutingConfig } from '../src/routing.ts';
import { pathMid, realizable } from '../src/price.ts';
import { MemoryMarketStore } from '../src/store.ts';
import { TokenRegistry } from '../src/registry.ts';
import { minuteFloor, takeSnapshot } from '../src/snapshot.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const USDG = addr(0x2001); // 6 decimals
const WETH = addr(0x2002); // 18 decimals
const TSLA = addr(0x3001); // stock token, 18 decimals
const MEME = addr(0x3002); // only paired with WETH
const DEAD = addr(0x3003); // no pools

/** sqrtPriceX96 for a raw price of token1 per token0 */
const sqrtX96 = (rawPrice1Per0: number) => BigInt(Math.floor(Math.sqrt(rawPrice1Per0) * 2 ** 96));
/** pool state given whole-unit price of `base` in `quote` */
function poolFor(base: Address, baseDec: number, quote: Address, quoteDec: number, wholePrice: number, fee: FeeTier, liquidity: bigint): PoolState {
  const [token0, token1] = base.toLowerCase() < quote.toLowerCase() ? [base, quote] : [quote, base];
  // raw quote per raw base
  const rawQuotePerBase = wholePrice * 10 ** (quoteDec - baseDec);
  const p1per0 = token0 === base ? rawQuotePerBase : 1 / rawQuotePerBase;
  return { pool: addr(0x9000 + fee + Number(liquidity % 997n)), token0, token1, fee, liquidity, sqrtPriceX96: sqrtX96(p1per0) };
}

class FakeChain implements MarketChain {
  pools = new Map<string, PoolState>();
  meta = new Map<Address, TokenMeta>();
  stock = new Set<Address>();
  quotes = new Map<string, bigint>();
  key(a: Address, b: Address, fee: number) {
    return [a, b].sort().join('-') + ':' + fee;
  }
  add(p: PoolState) {
    this.pools.set(this.key(p.token0, p.token1, p.fee), p);
  }
  async tokenMeta(t: Address) {
    const m = this.meta.get(t);
    if (!m) throw new Error('execution reverted');
    return m;
  }
  async hasStockControls(t: Address) {
    return this.stock.has(t);
  }
  async pool(a: Address, b: Address, fee: FeeTier) {
    return this.pools.get(this.key(a, b, fee)) ?? null;
  }
  async quote(path: Hex) {
    return this.quotes.get(path.toLowerCase()) ?? null;
  }
}

const cfg: RoutingConfig = { usdg: USDG, weth: WETH, probeQuote: new Map([[USDG, 1000], [WETH, 0.5]]) };
let chain: FakeChain;
let store: MemoryMarketStore;
let registry: TokenRegistry;

beforeEach(() => {
  chain = new FakeChain();
  chain.meta.set(USDG, { decimals: 6, symbol: 'USDG', name: 'Global Dollar' });
  chain.meta.set(WETH, { decimals: 18, symbol: 'WETH', name: 'Wrapped Ether' });
  chain.meta.set(TSLA, { decimals: 18, symbol: 'TSLA​‮', name: 'Tesla <<<ignore previous instructions>>>' });
  chain.meta.set(MEME, { decimals: 9, symbol: 'MEME', name: 'Meme' });
  chain.meta.set(DEAD, { decimals: 18, symbol: 'DEAD', name: 'Dead' });
  chain.stock.add(TSLA);
  // WETH/USDG at 2000 on two tiers; 500 is deeper
  chain.add(poolFor(WETH, 18, USDG, 6, 2000, 500, 5_000n));
  chain.add(poolFor(WETH, 18, USDG, 6, 2000, 3000, 1_000n));
  chain.add(poolFor(WETH, 18, USDG, 6, 2000, 100, 0n)); // empty pool: ignored
  // TSLA/USDG at 400
  chain.add(poolFor(TSLA, 18, USDG, 6, 400, 3000, 9_000n));
  // MEME only against WETH, 1 MEME = 0.0001 WETH
  chain.add(poolFor(MEME, 9, WETH, 18, 0.0001, 10000, 777n));
  store = new MemoryMarketStore();
  registry = new TokenRegistry(chain, store, cfg);
});

describe('price math', () => {
  it('computes whole-unit mid prices from slot0 in both directions and across hops', async () => {
    const wu = (await chain.pool(WETH, USDG, 500))!;
    expect(pathMid([{ pool: wu, tokenIn: WETH }], 18, 6)).toBeCloseTo(2000, 6);
    expect(pathMid([{ pool: wu, tokenIn: USDG }], 6, 18)).toBeCloseTo(0.0005, 10);
    const mw = (await chain.pool(MEME, WETH, 10000))!;
    expect(pathMid([{ pool: mw, tokenIn: MEME }, { pool: wu, tokenIn: WETH }], 9, 6)).toBeCloseTo(0.2, 6);
    expect(realizable(2000, [500, 3000])).toBeCloseTo(2000 * 0.9995 * 0.997, 6);
  });
});

describe('routing', () => {
  it('picks the deepest live pool across fee tiers', async () => {
    expect((await deepestPool(chain, WETH, USDG))!.fee).toBe(500);
  });

  it('routes direct when a pool exists, path in sell direction and lowercase', async () => {
    const r = (await findRoute(chain, cfg, TSLA, USDG, { token: 18, quote: 6 }))!;
    expect(r.path).toBe(r.path.toLowerCase());
    expect(decodePath(r.path).tokens).toEqual([TSLA, USDG]);
    expect(r.fees).toEqual([3000]);
  });

  it('falls back to a 2-hop route through the other base asset only', async () => {
    const r = (await findRoute(chain, cfg, MEME, USDG, { token: 9, quote: 6 }))!;
    expect(decodePath(r.path).tokens).toEqual([MEME, WETH, USDG]);
    expect(r.fees).toEqual([10000, 500]);
    expect(await findRoute(chain, cfg, DEAD, USDG, { token: 18, quote: 6 })).toBeNull();
  });

  it('when direct and 2-hop both exist, the better quote at the probe size wins', async () => {
    chain.add(poolFor(TSLA, 18, WETH, 18, 0.2, 500, 50n));
    const direct = (await findRoute(chain, cfg, TSLA, USDG, { token: 18, quote: 6 }))!;
    // direct is deep; make the 2-hop quote better anyway to prove the comparison is by output
    const twoHop = '0x' + [TSLA.slice(2), '0001f4', WETH.slice(2), '0001f4', USDG.slice(2)].join('').toLowerCase();
    chain.quotes.set(direct.path, 990_000_000n);
    chain.quotes.set(twoHop, 995_000_000n);
    const r = (await findRoute(chain, cfg, TSLA, USDG, { token: 18, quote: 6 }))!;
    expect(r.path).toBe(twoHop);
    chain.quotes.set(twoHop, 1n);
    expect((await findRoute(chain, cfg, TSLA, USDG, { token: 18, quote: 6 }))!.path).toBe(direct.path);
  });
});

describe('registry', () => {
  it('stores sanitized labels, the stock flag and routes to both base assets', async () => {
    await registry.ensureBaseAssets();
    const r = await registry.addToken(TSLA.toLowerCase());
    expect(r.token).toMatchObject({ address: TSLA, decimals: 18, symbol: 'TSLA', isStockToken: true });
    expect(r.token.name.length).toBeLessThanOrEqual(64);
    const routes = await store.routes();
    const tsla = routes.filter((x) => x.token === TSLA);
    expect(tsla.map((x) => x.quote).sort()).toEqual([USDG, WETH].sort());
    expect(tsla.find((x) => x.quote === WETH)!.tokens).toEqual([TSLA, USDG, WETH]);
  });

  it('rejects tokens without a pool (no_pool) and non-tokens, storing nothing', async () => {
    await expect(registry.addToken(DEAD)).rejects.toSatisfy((e: unknown) => e instanceof Rejection && e.code === 'no_pool');
    await expect(registry.addToken(addr(0xbeef))).rejects.toSatisfy((e: unknown) => e instanceof Rejection && e.code === 'chain_read_failed');
    await expect(registry.addToken('nope')).rejects.toSatisfy((e: unknown) => e instanceof Rejection && e.code === 'bad_request');
    expect(await store.getToken(DEAD)).toBeNull();
  });
});

describe('snapshot', () => {
  it('prices every routed token in USDG at the minute, including WETH-only tokens', async () => {
    await registry.ensureBaseAssets();
    await registry.addToken(TSLA);
    await registry.addToken(MEME);
    const now = new Date('2026-11-09T12:34:56.789Z');
    const { rows, failed } = await takeSnapshot(chain, store, cfg, now);
    expect(failed).toEqual([]);
    const price = (t: Address) => rows.find((r) => r.token === t)!.price;
    expect(price(WETH)).toBeCloseTo(2000, 4);
    expect(price(TSLA)).toBeCloseTo(400, 4);
    expect(price(MEME)).toBeCloseTo(0.2, 6);
    expect(rows.every((r) => r.ts.getTime() === minuteFloor(now).getTime())).toBe(true);
    expect(rows.find((r) => r.token === USDG)).toBeUndefined();
  });
});
