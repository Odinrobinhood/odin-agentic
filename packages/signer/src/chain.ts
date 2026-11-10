import { createPublicClient, fallback, http, parseAbi, zeroAddress, getAddress, type Address, type Hex } from 'viem';
import { EIP1967_BEACON_SLOT, ROBINHOOD_STOCK_BEACON, verifyEoaSignature } from '@odin/shared';

export interface ChainReader {
  chainId(): Promise<number>;
  routerFactory(router: Address): Promise<Address>;
  /** In-range liquidity of the pinned factory's pool for a pair and fee tier; null when no pool exists. */
  poolLiquidity(factory: Address, a: Address, b: Address, fee: number): Promise<bigint | null>;
  /** QuoterV2 quoteExactInput output for the path. */
  quote(quoter: Address, path: Hex, amountIn: bigint): Promise<bigint>;
  /** True only for Robinhood Stock Tokens (beacon proxy of the pinned Robinhood beacon). */
  isStockToken(token: Address): Promise<boolean>;
  /** QuoterV2's factory, for preflight. */
  quoterFactory(quoter: Address): Promise<Address>;
  /** Robinhood Stock Tokens: paused() or tokenPaused() (verified on-chain 2026-11-10; there is no per-wallet blocklist). */
  isPaused(token: Address): Promise<boolean>;
  /** EIP-191 signature by an EOA, verified locally (never by asking an RPC). */
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
}

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const routerAbi = parseAbi(['function factory() view returns (address)']);
const quoterAbi = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);
const stockAbi = parseAbi(['function paused() view returns (bool)', 'function tokenPaused() view returns (bool)']);

export class ViemChainReader implements ChainReader {
  private readonly client;
  constructor(rpcUrls: string[]) {
    // ordered fallback across RPC endpoints (architecture §3.9, §7)
    this.client = createPublicClient({
      transport: fallback(rpcUrls.map((u) => http(u, { timeout: 8_000, retryCount: 1 })), { rank: false }),
    });
  }

  chainId(): Promise<number> {
    return this.client.getChainId();
  }

  async routerFactory(router: Address): Promise<Address> {
    return getAddress(await this.client.readContract({ address: router, abi: routerAbi, functionName: 'factory' }));
  }

  async poolLiquidity(factory: Address, a: Address, b: Address, fee: number): Promise<bigint | null> {
    const pool = await this.client.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [a, b, fee] });
    if (pool === zeroAddress) return null;
    return this.client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' });
  }

  async quote(quoter: Address, path: Hex, amountIn: bigint): Promise<bigint> {
    const { result } = await this.client.simulateContract({ address: quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, amountIn] });
    return result[0];
  }

  async quoterFactory(quoter: Address): Promise<Address> {
    return getAddress(await this.client.readContract({ address: quoter, abi: routerAbi, functionName: 'factory' }));
  }

  async isStockToken(token: Address): Promise<boolean> {
    const slot = await this.client.getStorageAt({ address: token, slot: EIP1967_BEACON_SLOT });
    return !!slot && `0x${slot.slice(26)}`.toLowerCase() === ROBINHOOD_STOCK_BEACON;
  }

  async isPaused(token: Address): Promise<boolean> {
    const [paused, tokenPaused] = await Promise.all([
      this.client.readContract({ address: token, abi: stockAbi, functionName: 'paused' }),
      this.client.readContract({ address: token, abi: stockAbi, functionName: 'tokenPaused' }),
    ]);
    return paused || tokenPaused;
  }

  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean> {
    // key export is the highest-stakes check: local ECDSA recovery only, so no RPC answer can approve it.
    // Smart-wallet owners cannot export keys (they can still withdraw to their wallet).
    return verifyEoaSignature(address, message, signature);
  }
}
