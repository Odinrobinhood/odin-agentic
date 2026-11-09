import { createPublicClient, fallback, getAddress, http, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { FeeTier } from '@odin/shared';

export type PoolState = { pool: Address; token0: Address; token1: Address; fee: FeeTier; liquidity: bigint; sqrtPriceX96: bigint };
export type TokenMeta = { decimals: number; symbol: unknown; name: unknown };

/** Chain reads Market Data needs. Everything is a read; nothing here can sign. */
export interface MarketChain {
  tokenMeta(token: Address): Promise<TokenMeta>;
  /** True when the token exposes the Stock Token controls (paused() and isBlocked(address)). */
  hasStockControls(token: Address): Promise<boolean>;
  /** Pool from the pinned factory with its live state, or null if none exists. */
  pool(a: Address, b: Address, fee: FeeTier): Promise<PoolState | null>;
  /** QuoterV2 quoteExactInput; null if the quote reverts. */
  quote(path: Hex, amountIn: bigint): Promise<bigint | null>;
}

const erc20Abi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)']);
const bytes32Abi = parseAbi(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);
const stockAbi = parseAbi(['function paused() view returns (bool)', 'function isBlocked(address) view returns (bool)']);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

export class ViemMarketChain implements MarketChain {
  private readonly c;
  private readonly factory: Address;
  private readonly quoter: Address;

  constructor(cfg: { rpcUrls: string[]; factory: Address; quoter: Address }) {
    this.c = createPublicClient({ transport: fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 8_000, retryCount: 1 })), { rank: false }) });
    this.factory = cfg.factory;
    this.quoter = cfg.quoter;
  }

  async tokenMeta(token: Address): Promise<TokenMeta> {
    const decimals = await this.c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
    const str = async (fn: 'symbol' | 'name'): Promise<unknown> => {
      try {
        return await this.c.readContract({ address: token, abi: erc20Abi, functionName: fn });
      } catch {
        // some tokens return bytes32 instead of string
        try {
          const b = await this.c.readContract({ address: token, abi: bytes32Abi, functionName: fn });
          return Buffer.from(b.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
        } catch {
          return '';
        }
      }
    };
    return { decimals, symbol: await str('symbol'), name: await str('name') };
  }

  async hasStockControls(token: Address): Promise<boolean> {
    try {
      await this.c.readContract({ address: token, abi: stockAbi, functionName: 'paused' });
      await this.c.readContract({ address: token, abi: stockAbi, functionName: 'isBlocked', args: [zeroAddress] });
      return true;
    } catch {
      return false;
    }
  }

  async pool(a: Address, b: Address, fee: FeeTier): Promise<PoolState | null> {
    const pool = await this.c.readContract({ address: this.factory, abi: factoryAbi, functionName: 'getPool', args: [a, b, fee] });
    if (pool === zeroAddress) return null;
    const [liquidity, slot0] = await Promise.all([
      this.c.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
      this.c.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    ]);
    const [token0, token1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    return { pool: getAddress(pool), token0, token1, fee, liquidity, sqrtPriceX96: slot0[0] };
  }

  async quote(path: Hex, amountIn: bigint): Promise<bigint | null> {
    try {
      const { result } = await this.c.simulateContract({ address: this.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, amountIn] });
      return result[0];
    } catch {
      return null;
    }
  }
}
