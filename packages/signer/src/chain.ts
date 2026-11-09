import { createPublicClient, fallback, http, parseAbi, zeroAddress, getAddress, type Address } from 'viem';

export interface ChainReader {
  chainId(): Promise<number>;
  routerFactory(router: Address): Promise<Address>;
  /** Pool from the pinned factory, or null if none exists / it holds no liquidity. */
  liquidPool(factory: Address, a: Address, b: Address, fee: number): Promise<Address | null>;
  isPaused(token: Address): Promise<boolean>;
  isBlocked(token: Address, wallet: Address): Promise<boolean>;
}

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const routerAbi = parseAbi(['function factory() view returns (address)']);
const stockAbi = parseAbi(['function paused() view returns (bool)', 'function isBlocked(address) view returns (bool)']);

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

  async liquidPool(factory: Address, a: Address, b: Address, fee: number): Promise<Address | null> {
    const pool = await this.client.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [a, b, fee] });
    if (pool === zeroAddress) return null;
    const liq = await this.client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' });
    return liq > 0n ? getAddress(pool) : null;
  }

  isPaused(token: Address): Promise<boolean> {
    return this.client.readContract({ address: token, abi: stockAbi, functionName: 'paused' });
  }

  isBlocked(token: Address, wallet: Address): Promise<boolean> {
    return this.client.readContract({ address: token, abi: stockAbi, functionName: 'isBlocked', args: [wallet] });
  }
}
