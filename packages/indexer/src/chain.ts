import { createPublicClient, fallback, getAddress, http, type Address, type Hex } from 'viem';

export const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
export const SWAP_TOPIC: Hex = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/**
 * blockTimestamp is part of newer log responses. Robinhood Chain RPCs return the field but as 0x0, so a zero
 * value is treated as absent and the indexer fetches (batched) block headers instead.
 */
export type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number; blockTimestamp?: bigint };

export interface IndexerChain {
  head(): Promise<bigint>;
  block(n: bigint): Promise<{ hash: Hex; timestamp: bigint }>;
  logs(address: Address, topic: Hex, from: bigint, to: bigint): Promise<RawLog[]>;
  /** Contract code exists at this block (for finding a deployment block). */
  hasCode(address: Address, at: bigint): Promise<boolean>;
}

export class ViemIndexerChain implements IndexerChain {
  private readonly c;
  constructor(rpcUrls: string[]) {
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 15_000, retryCount: 2, batch: { batchSize: 100 } })), { rank: false }) });
  }
  head(): Promise<bigint> {
    return this.c.getBlockNumber();
  }
  async block(n: bigint) {
    const b = await this.c.getBlock({ blockNumber: n });
    return { hash: b.hash!, timestamp: b.timestamp };
  }
  async logs(address: Address, topic: Hex, from: bigint, to: bigint): Promise<RawLog[]> {
    const raw = await this.c.request({
      method: 'eth_getLogs',
      params: [{ address, topics: [topic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    });
    return (raw as { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; blockTimestamp?: Hex }[]).map((l) => ({
      address: getAddress(l.address), topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: Number(l.logIndex),
      ...(l.blockTimestamp && BigInt(l.blockTimestamp) > 0n ? { blockTimestamp: BigInt(l.blockTimestamp) } : {}),
    }));
  }
  async hasCode(address: Address, at: bigint): Promise<boolean> {
    const code = await this.c.getCode({ address, blockNumber: at });
    return !!code && code !== '0x';
  }
}

/** Binary search for the first block where `address` has code (its deployment block). */
export async function deploymentBlock(chain: IndexerChain, address: Address, head: bigint): Promise<bigint | null> {
  if (!(await chain.hasCode(address, head))) return null;
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await chain.hasCode(address, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}
