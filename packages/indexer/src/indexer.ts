import { getAddress, type Hex } from 'viem';
import { SWAP_TOPIC, TRANSFER_TOPIC, deploymentBlock, type IndexerChain, type RawLog } from './chain.ts';
import type { IndexerStore, Stream, SwapRow, TransferRow } from './store.ts';

export type IndexerConfig = {
  /** Index only up to head - confirmations (sequencer reorgs are rare but not impossible). */
  confirmations: bigint;
  /** Blocks per eth_getLogs call. Robinhood Chain makes ~10 blocks/s. */
  batchBlocks: bigint;
  /** On a detected reorg, rewind this far and re-index. */
  reorgDepth: bigint;
  /** Never backfill earlier than this block (staging keeps history short). Null = from deployment. */
  minStartBlock: bigint | null;
};

const topicAddr = (t: Hex | undefined) => getAddress(`0x${(t ?? '0x').slice(26)}`);
const int256 = (word: string) => {
  const v = BigInt(`0x${word}`);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};

export function decodeTransfer(l: RawLog, time: Date): TransferRow | null {
  if (l.topics.length !== 3) return null; // ERC-721 style or non-standard: not an ERC-20 transfer
  return { block: l.blockNumber, blockTime: time, txHash: l.transactionHash, logIndex: l.logIndex, token: l.address, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), amount: BigInt(l.data === '0x' ? 0 : l.data) };
}

/** Uniswap v3 Swap; price = token1 per token0 in raw units, from the post-swap sqrtPriceX96. */
export function decodeSwap(l: RawLog, time: Date): SwapRow | null {
  const d = l.data.slice(2);
  if (d.length < 64 * 5 || l.topics.length !== 3) return null;
  const sqrt = Number(BigInt(`0x${d.slice(128, 192)}`)) / 2 ** 96;
  return {
    block: l.blockNumber, blockTime: time, txHash: l.transactionHash, logIndex: l.logIndex, pool: l.address,
    sender: topicAddr(l.topics[1]), recipient: topicAddr(l.topics[2]), amount0: int256(d.slice(0, 64)), amount1: int256(d.slice(64, 128)), price: sqrt * sqrt,
  };
}

/**
 * Chain Indexer (architecture §3.12). Each token / pool is its own stream so a newly registered contract
 * is backfilled from its deployment block (or the configured floor) without holding the others back.
 */
export class Indexer {
  private readonly chain: IndexerChain;
  private readonly store: IndexerStore;
  private readonly cfg: IndexerConfig;

  constructor(chain: IndexerChain, store: IndexerStore, cfg: IndexerConfig) {
    this.chain = chain;
    this.store = store;
    this.cfg = cfg;
  }

  /** Create streams for contracts that have none yet. */
  async enroll(): Promise<number> {
    const have = new Set((await this.store.streams()).map((s) => `${s.kind}:${s.contract}`));
    const head = await this.chain.head();
    let n = 0;
    for (const t of await this.store.targets()) {
      if (have.has(`${t.kind}:${t.contract}`)) continue;
      const deployed = (await deploymentBlock(this.chain, t.contract, head)) ?? head;
      const start = this.cfg.minStartBlock !== null && this.cfg.minStartBlock > deployed ? this.cfg.minStartBlock : deployed;
      const prev = start > 0n ? await this.chain.block(start - 1n) : { hash: '0x' as Hex };
      await this.store.createStream(t.kind, t.contract, start, prev.hash);
      n++;
    }
    return n;
  }

  /** Advance every stream by at most one batch. Returns blocks indexed per stream. */
  async step(): Promise<{ stream: string; from: bigint; to: bigint; rows: number; reorg?: boolean }[]> {
    const safeHead = (await this.chain.head()) - this.cfg.confirmations;
    const out: { stream: string; from: bigint; to: bigint; rows: number; reorg?: boolean }[] = [];
    for (const s of await this.store.streams()) {
      if (s.lastBlock >= safeHead) continue;
      if (await this.reorged(s)) {
        const back = s.lastBlock - this.cfg.reorgDepth > s.startBlock - 1n ? s.lastBlock - this.cfg.reorgDepth : s.startBlock - 1n;
        const b = await this.chain.block(back);
        await this.store.rewind(s, back, b.hash);
        out.push({ stream: s.name, from: back, to: back, rows: 0, reorg: true });
        continue;
      }
      const from = s.lastBlock + 1n;
      const to = from + this.cfg.batchBlocks - 1n < safeHead ? from + this.cfg.batchBlocks - 1n : safeHead;
      const logs = await this.chain.logs(s.contract, s.kind === 'transfer' ? TRANSFER_TOPIC : SWAP_TOPIC, from, to);
      // use the timestamps the RPC returns with each log; fetch headers only for logs without one
      const times = new Map<bigint, Date>(logs.filter((l) => l.blockTimestamp !== undefined && l.blockTimestamp > 0n).map((l) => [l.blockNumber, new Date(Number(l.blockTimestamp) * 1000)]));
      for (const [b, t] of await this.blockTimes([...new Set(logs.filter((l) => !times.has(l.blockNumber)).map((l) => l.blockNumber))])) times.set(b, t);
      const end = await this.chain.block(to);
      const transfers: TransferRow[] = [];
      const swaps: SwapRow[] = [];
      for (const l of logs) {
        const t = times.get(l.blockNumber)!;
        if (s.kind === 'transfer') {
          const r = decodeTransfer(l, t);
          if (r) transfers.push(r);
        } else {
          const r = decodeSwap(l, t);
          if (r) swaps.push(r);
        }
      }
      await this.store.commit(s, to, end.hash, transfers, swaps);
      out.push({ stream: s.name, from, to, rows: transfers.length + swaps.length });
    }
    return out;
  }

  private async reorged(s: Stream): Promise<boolean> {
    if (s.lastBlock < s.startBlock || s.lastBlockHash === '0x') return false;
    return (await this.chain.block(s.lastBlock)).hash !== s.lastBlockHash;
  }

  private async blockTimes(blocks: bigint[]): Promise<Map<bigint, Date>> {
    const out = new Map<bigint, Date>();
    for (let i = 0; i < blocks.length; i += 100) {
      const part = blocks.slice(i, i + 100);
      const got = await Promise.all(part.map((b) => this.chain.block(b)));
      part.forEach((b, k) => out.set(b, new Date(Number(got[k]!.timestamp) * 1000)));
    }
    return out;
  }
}

