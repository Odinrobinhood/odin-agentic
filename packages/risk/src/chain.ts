import { createPublicClient, fallback, http, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { Rejection, decodePath } from '@odin/shared';
import type { BalanceReader, RiskChain } from './ports.ts';
import type { AgentRiskContext } from './types.ts';

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);
const feedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
const stockAbi = parseAbi(['function paused() view returns (bool)', 'function isBlocked(address) view returns (bool)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** USD reference for a token: a Chainlink feed, or a fixed value (e.g. a USD stablecoin used as quote). */
export type RefereeSource = { feed: Address; maxAgeSeconds: number } | { fixedUsd: number };

export type ViemRiskChainConfig = {
  rpcUrls: string[];
  factory: Address;
  quoter: Address;
  referees: Map<Address, RefereeSource>;
  now?: () => Date;
};

function makeClient(rpcUrls: string[]) {
  // ordered fallback across RPC endpoints (architecture §7)
  return createPublicClient({
    transport: fallback(rpcUrls.map((u) => http(u, { timeout: 8_000, retryCount: 1 })), { rank: false }),
  });
}

export class ViemRiskChain implements RiskChain {
  private readonly c;
  private readonly cfg: ViemRiskChainConfig;
  private readonly now: () => Date;

  constructor(cfg: ViemRiskChainConfig) {
    this.cfg = cfg;
    this.c = makeClient(cfg.rpcUrls);
    this.now = cfg.now ?? (() => new Date());
  }

  async midRate(path: Hex): Promise<number> {
    let rate = 1;
    for (const h of decodePath(path).hops) {
      const pool = await this.c.readContract({ address: this.cfg.factory, abi: factoryAbi, functionName: 'getPool', args: [h.tokenIn, h.tokenOut, h.fee] });
      if (pool === zeroAddress) throw new Rejection('no_pool', `no pool for ${h.tokenIn}/${h.tokenOut} fee ${h.fee}`);
      const [sqrtPriceX96] = await this.c.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' });
      if (sqrtPriceX96 === 0n) throw new Rejection('no_pool', `pool ${pool} is not initialized`);
      const s = Number(sqrtPriceX96) / 2 ** 96;
      const token1PerToken0 = s * s; // raw units
      // Uniswap orders token0 < token1 by address
      const inIsToken0 = h.tokenIn.toLowerCase() < h.tokenOut.toLowerCase();
      rate *= inIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
    }
    return rate;
  }

  async quoteExactInput(path: Hex, amountIn: bigint): Promise<bigint> {
    const { result } = await this.c.simulateContract({ address: this.cfg.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, amountIn] });
    return result[0];
  }

  async refereePrice(token: Address, quote: Address): Promise<number | null> {
    const [t, q] = await Promise.all([this.usd(token), this.usd(quote)]);
    if (t === null || q === null || q <= 0) return null;
    return t / q;
  }

  isPaused(token: Address): Promise<boolean> {
    return this.c.readContract({ address: token, abi: stockAbi, functionName: 'paused' });
  }

  isBlocked(token: Address, wallet: Address): Promise<boolean> {
    return this.c.readContract({ address: token, abi: stockAbi, functionName: 'isBlocked', args: [wallet] });
  }

  /** USD price from the configured source; null when absent, non-positive or stale (the referee is then skipped). */
  private async usd(token: Address): Promise<number | null> {
    const src = this.cfg.referees.get(token);
    if (!src) return null;
    if ('fixedUsd' in src) return src.fixedUsd;
    const [decimals, round] = await Promise.all([
      this.c.readContract({ address: src.feed, abi: feedAbi, functionName: 'decimals' }),
      this.c.readContract({ address: src.feed, abi: feedAbi, functionName: 'latestRoundData' }),
    ]);
    const [, answer, , updatedAt] = round;
    if (answer <= 0n) return null;
    const age = Math.floor(this.now().getTime() / 1000) - Number(updatedAt);
    if (age > src.maxAgeSeconds) return null;
    return Number(answer) / 10 ** decimals;
  }
}

/** Live balances straight from the chain. */
export class ViemBalanceReader implements BalanceReader {
  private readonly c;
  constructor(rpcUrls: string[]) {
    this.c = makeClient(rpcUrls);
  }
  token(ctx: AgentRiskContext, token: Address): Promise<bigint> {
    return this.c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.wallet] });
  }
  native(ctx: AgentRiskContext): Promise<bigint> {
    return this.c.getBalance({ address: ctx.wallet });
  }
}
