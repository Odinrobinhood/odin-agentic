import { createPool } from '@odin/db';
import { ViemIndexerChain } from './chain.ts';
import { Indexer } from './indexer.ts';
import { PgIndexerStore } from './store.ts';

const rpcUrls = (process.env.CHAIN_RPC_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (rpcUrls.length === 0) throw new Error('CHAIN_RPC_URLS is required');
const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 4 });
const chain = new ViemIndexerChain(rpcUrls);
const head = await chain.head();
// staging keeps history short: INDEXER_MIN_START_BLOCK, else INDEXER_LOOKBACK_BLOCKS behind the current head
const lookback = BigInt(process.env.INDEXER_LOOKBACK_BLOCKS ?? '36000'); // ~1 hour at 10 blocks/s
const minStart = process.env.INDEXER_MIN_START_BLOCK === 'deployment' ? null : BigInt(process.env.INDEXER_MIN_START_BLOCK ?? (head - lookback).toString());
const indexer = new Indexer(chain, new PgIndexerStore(pool), {
  confirmations: BigInt(process.env.INDEXER_CONFIRMATIONS ?? '20'),
  batchBlocks: BigInt(process.env.INDEXER_BATCH_BLOCKS ?? '2000'),
  reorgDepth: BigInt(process.env.INDEXER_REORG_DEPTH ?? '200'),
  minStartBlock: minStart,
});
const log = (o: object) => console.log(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
log({ msg: 'indexer up', head, minStartBlock: minStart });

let lastEnroll = 0;
for (;;) {
  try {
    if (Date.now() - lastEnroll > 60_000) {
      const n = await indexer.enroll();
      lastEnroll = Date.now();
      if (n) log({ msg: 'streams enrolled', n });
    }
    const steps = await indexer.step();
    const rows = steps.reduce((a, s) => a + s.rows, 0);
    for (const s of steps.filter((x) => x.reorg)) log({ msg: 'reorg rewind', ...s });
    if (rows) log({ msg: 'indexed', streams: steps.length, rows });
    // caught up: every stream at the safe head
    if (steps.length === 0) await new Promise((r) => setTimeout(r, 2_000));
  } catch (e) {
    log({ msg: 'index step failed', error: (e as Error).message.split('\n')[0] });
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
