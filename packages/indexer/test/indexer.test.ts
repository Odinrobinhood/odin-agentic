import { describe, expect, it } from 'vitest';
import { getAddress, toHex, type Address, type Hex } from 'viem';
import { SWAP_TOPIC, TRANSFER_TOPIC, deploymentBlock, type IndexerChain, type RawLog } from '../src/chain.ts';
import { Indexer, decodeSwap, decodeTransfer } from '../src/indexer.ts';
import { streamName, type IndexerStore, type Stream, type SwapRow, type TransferRow } from '../src/store.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const TOKEN = addr(0x1111);
const POOL = addr(0x2222);
const A = addr(0xa);
const B = addr(0xb);
const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
const word = (v: bigint) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');

class FakeChain implements IndexerChain {
  headBlock = 1000n;
  deployedAt = 100n;
  hashes = new Map<bigint, Hex>();
  logList: RawLog[] = [];
  calls: [bigint, bigint][] = [];
  async head() {
    return this.headBlock;
  }
  async block(n: bigint) {
    return { hash: this.hashes.get(n) ?? (`0x${n.toString(16).padStart(64, '0')}` as Hex), timestamp: 1_700_000_000n + n };
  }
  async logs(address: Address, t: Hex, from: bigint, to: bigint) {
    this.calls.push([from, to]);
    return this.logList.filter((l) => l.address === address && l.topics[0] === t && l.blockNumber >= from && l.blockNumber <= to);
  }
  async hasCode(_a: Address, at: bigint) {
    return at >= this.deployedAt;
  }
}

class MemStore implements IndexerStore {
  list: Stream[] = [];
  transfers: TransferRow[] = [];
  swaps: SwapRow[] = [];
  tgt: { kind: 'transfer' | 'swap'; contract: Address }[] = [{ kind: 'transfer', contract: TOKEN }, { kind: 'swap', contract: POOL }];
  async targets() {
    return this.tgt;
  }
  async streams() {
    return this.list.map((s) => ({ ...s }));
  }
  async createStream(kind: 'transfer' | 'swap', contract: Address, startBlock: bigint, startHash: string) {
    this.list.push({ name: streamName(kind, contract), kind, contract, startBlock, lastBlock: startBlock - 1n, lastBlockHash: startHash });
  }
  async commit(s: Stream, to: bigint, hash: string, t: TransferRow[], w: SwapRow[]) {
    this.transfers.push(...t);
    this.swaps.push(...w);
    Object.assign(this.list.find((x) => x.name === s.name)!, { lastBlock: to, lastBlockHash: hash });
  }
  async rewind(s: Stream, block: bigint, hash: string) {
    if (s.kind === 'transfer') this.transfers = this.transfers.filter((t) => t.block <= block);
    Object.assign(this.list.find((x) => x.name === s.name)!, { lastBlock: block, lastBlockHash: hash });
  }
}

const transferLog = (block: bigint, amount: bigint): RawLog => ({
  address: TOKEN, topics: [TRANSFER_TOPIC, topic(A), topic(B)], data: toHex(amount, { size: 32 }), blockNumber: block, blockHash: '0x', transactionHash: `0x${block.toString(16).padStart(64, 'f')}`, logIndex: 0,
});

describe('indexer', () => {
  it('finds the deployment block by binary search', async () => {
    const c = new FakeChain();
    c.deployedAt = 377n;
    expect(await deploymentBlock(c, TOKEN, 1000n)).toBe(377n);
    c.deployedAt = 2000n;
    expect(await deploymentBlock(c, TOKEN, 1000n)).toBeNull();
  });

  it('backfills from max(deployment, floor) in batches up to head - confirmations', async () => {
    const c = new FakeChain();
    const s = new MemStore();
    const ix = new Indexer(c, s, { confirmations: 20n, batchBlocks: 400n, reorgDepth: 50n, minStartBlock: 300n });
    expect(await ix.enroll()).toBe(2);
    expect(s.list.map((x) => x.startBlock)).toEqual([300n, 300n]);
    expect(await ix.enroll()).toBe(0);
    c.logList = [transferLog(299n, 1n), transferLog(310n, 5n), transferLog(900n, 7n), transferLog(990n, 9n)];
    await ix.step(); // 300..699
    await ix.step(); // 700..980
    expect(await ix.step()).toEqual([]); // caught up
    expect(s.transfers.map((t) => [t.block, t.amount])).toEqual([[310n, 5n], [900n, 7n]]);
    expect(s.list[0]!.lastBlock).toBe(980n);
    expect(s.transfers[0]).toMatchObject({ token: TOKEN, from: A, to: B, blockTime: new Date((1_700_000_000 + 310) * 1000) });
  });

  it('uses the blockTimestamp returned with logs instead of fetching headers', async () => {
    const c = new FakeChain();
    const s = new MemStore();
    s.tgt = [{ kind: 'transfer', contract: TOKEN }];
    const ix = new Indexer(c, s, { confirmations: 0n, batchBlocks: 1000n, reorgDepth: 10n, minStartBlock: 900n });
    await ix.enroll();
    c.logList = [{ ...transferLog(950n, 1n), blockTimestamp: 42n }];
    await ix.step();
    expect(s.transfers[0]!.blockTime).toEqual(new Date(42_000));
  });

  it('treats a zero blockTimestamp (as Robinhood Chain RPCs return it) as missing and reads the header', async () => {
    const c = new FakeChain();
    const s = new MemStore();
    s.tgt = [{ kind: 'transfer', contract: TOKEN }];
    const ix = new Indexer(c, s, { confirmations: 0n, batchBlocks: 1000n, reorgDepth: 10n, minStartBlock: 900n });
    await ix.enroll();
    c.logList = [{ ...transferLog(950n, 1n), blockTimestamp: 0n }];
    await ix.step();
    expect(s.transfers[0]!.blockTime).toEqual(new Date((1_700_000_000 + 950) * 1000));
  });

  it('rewinds on a reorg and re-indexes the replaced blocks', async () => {
    const c = new FakeChain();
    const s = new MemStore();
    s.tgt = [{ kind: 'transfer', contract: TOKEN }];
    const ix = new Indexer(c, s, { confirmations: 0n, batchBlocks: 1000n, reorgDepth: 100n, minStartBlock: 500n });
    await ix.enroll();
    c.logList = [transferLog(950n, 1n)];
    await ix.step();
    expect(s.transfers).toHaveLength(1);
    // block 1000 replaced and the log at 950 dropped from the canonical chain
    c.hashes.set(1000n, `0x${'ab'.repeat(32)}`);
    c.logList = [transferLog(960n, 2n)];
    c.headBlock = 1100n;
    const [r] = await ix.step();
    expect(r).toMatchObject({ reorg: true, from: 900n });
    expect(s.transfers).toHaveLength(0);
    await ix.step();
    expect(s.transfers.map((t) => t.amount)).toEqual([2n]);
  });

  it('decodes ERC-20 transfers (not ERC-721) and v3 swaps with signed amounts', () => {
    const t = new Date();
    expect(decodeTransfer({ ...transferLog(1n, 3n), topics: [TRANSFER_TOPIC, topic(A), topic(B), topic(A)] }, t)).toBeNull();
    const sqrt = 2n ** 96n * 3n; // price = 9
    const swap: RawLog = {
      address: POOL, topics: [SWAP_TOPIC, topic(A), topic(B)], data: `0x${word(-5n)}${word(10n)}${word(sqrt)}${word(1n)}${word(0n)}`,
      blockNumber: 1n, blockHash: '0x', transactionHash: '0x01', logIndex: 2,
    };
    expect(decodeSwap(swap, t)).toMatchObject({ pool: POOL, sender: A, recipient: B, amount0: -5n, amount1: 10n, price: 9 });
  });
});
