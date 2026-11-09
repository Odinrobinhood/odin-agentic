import { getAddress, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';

export type Stream = { name: string; kind: 'transfer' | 'swap'; contract: Address; lastBlock: bigint; lastBlockHash: string; startBlock: bigint };
export type TransferRow = { block: bigint; blockTime: Date; txHash: Hex; logIndex: number; token: Address; from: Address; to: Address; amount: bigint };
export type SwapRow = { block: bigint; blockTime: Date; txHash: Hex; logIndex: number; pool: Address; sender: Address; recipient: Address; amount0: bigint; amount1: bigint; price: number };

export interface IndexerStore {
  /** Contracts that should be indexed: every registry token (Transfer) and every routed pool (Swap). */
  targets(): Promise<{ kind: 'transfer' | 'swap'; contract: Address }[]>;
  streams(): Promise<Stream[]>;
  createStream(kind: 'transfer' | 'swap', contract: Address, startBlock: bigint, startHash: string): Promise<void>;
  /** Write one batch and advance the stream atomically. */
  commit(stream: Stream, toBlock: bigint, toHash: string, transfers: TransferRow[], swaps: SwapRow[]): Promise<void>;
  /** Reorg: drop everything the stream wrote after `block` and move it back there. */
  rewind(stream: Stream, block: bigint, hash: string): Promise<void>;
}

const lc = (a: string) => a.toLowerCase();

/** Multi-row INSERT in chunks (one round trip per 500 rows instead of one per row). */
async function insertMany(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, target: string, rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const width = chunk[0]!.length;
    const values = chunk.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`).join(', ');
    await client.query(`INSERT INTO ${target} VALUES ${values} ON CONFLICT DO NOTHING`, chunk.flat());
  }
}
export const streamName = (kind: 'transfer' | 'swap', contract: Address) => `${kind}:${lc(contract)}`;

export class PgIndexerStore implements IndexerStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async targets() {
    const t = await this.pool.query<{ address: string }>('SELECT address FROM tokens');
    const p = await this.pool.query<{ pool: string }>('SELECT DISTINCT unnest(pools::text[]) AS pool FROM routes');
    return [
      ...t.rows.map((r) => ({ kind: 'transfer' as const, contract: getAddress(r.address) })),
      ...p.rows.map((r) => ({ kind: 'swap' as const, contract: getAddress(r.pool) })),
    ];
  }

  async streams(): Promise<Stream[]> {
    const r = await this.pool.query<{ stream: string; contract: string; last_block: string; last_block_hash: string; start_block: string }>(
      `SELECT stream, contract, last_block, last_block_hash, start_block FROM indexer_state WHERE contract IS NOT NULL`,
    );
    return r.rows.map((x) => ({
      name: x.stream, kind: x.stream.startsWith('swap:') ? 'swap' : 'transfer', contract: getAddress(x.contract),
      lastBlock: BigInt(x.last_block), lastBlockHash: x.last_block_hash, startBlock: BigInt(x.start_block),
    }));
  }

  async createStream(kind: 'transfer' | 'swap', contract: Address, startBlock: bigint, startHash: string) {
    // last_block = start - 1: the first batch begins at the start block
    await this.pool.query(
      `INSERT INTO indexer_state (stream, contract, start_block, last_block, last_block_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (stream) DO NOTHING`,
      [streamName(kind, contract), lc(contract), startBlock.toString(), (startBlock - 1n).toString(), startHash],
    );
  }

  async commit(s: Stream, toBlock: bigint, toHash: string, transfers: TransferRow[], swaps: SwapRow[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await insertMany(client, 'transfers (block, block_time, tx_hash, log_index, token_address, "from", "to", amount)', transfers.map((t) =>
        [t.block.toString(), t.blockTime, t.txHash, t.logIndex, lc(t.token), lc(t.from), lc(t.to), t.amount.toString()]));
      await insertMany(client, 'swaps (block, block_time, tx_hash, log_index, pool, sender, recipient, amount0, amount1, price)', swaps.map((w) =>
        [w.block.toString(), w.blockTime, w.txHash, w.logIndex, lc(w.pool), lc(w.sender), lc(w.recipient), w.amount0.toString(), w.amount1.toString(), w.price]));
      // optimistic: only advance if nobody else moved the stream meanwhile
      const r = await client.query('UPDATE indexer_state SET last_block = $2, last_block_hash = $3, updated_at = now() WHERE stream = $1 AND last_block = $4', [
        s.name, toBlock.toString(), toHash, s.lastBlock.toString(),
      ]);
      if (r.rowCount !== 1) throw new Error(`stream ${s.name} moved concurrently`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async rewind(s: Stream, block: bigint, hash: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (s.kind === 'transfer') await client.query('DELETE FROM transfers WHERE token_address = $1 AND block > $2', [lc(s.contract), block.toString()]);
      else await client.query('DELETE FROM swaps WHERE pool = $1 AND block > $2', [lc(s.contract), block.toString()]);
      await client.query('UPDATE indexer_state SET last_block = $2, last_block_hash = $3, updated_at = now() WHERE stream = $1', [s.name, block.toString(), hash]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
