import { Rejection } from '@odin/shared';
import type { Pool } from '@odin/db';

export type Channel = 'agent' | 'guard';

export type LedgerEntry = {
  agentId: string;
  channel: Channel;
  kind: 'approve' | 'swap';
  txHash: string;
  nonce: number;
  cap: number;
};

export interface Ledger {
  /**
   * Atomically check the per-agent, per-channel daily cap and record the signature.
   * Must succeed before the signed transaction is returned to the caller.
   */
  record(entry: LedgerEntry, now: Date): Promise<void>;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class PgLedger implements Ledger {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async record(e: LedgerEntry, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // serialise all signatures of one agent+channel so the count cannot race
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${e.agentId}:${e.channel}`]);
      const day = utcDay(now);
      const used = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM signer_signatures WHERE agent_id = $1 AND channel = $2 AND day = $3',
        [e.agentId, e.channel, day],
      );
      if (Number(used.rows[0]?.n ?? 0) >= e.cap) {
        throw new Rejection('signature_cap_reached', `${e.channel} signature cap of ${e.cap}/day reached`);
      }
      await client.query(
        'INSERT INTO signer_signatures (agent_id, channel, kind, day, tx_hash, nonce) VALUES ($1, $2, $3, $4, $5, $6)',
        [e.agentId, e.channel, e.kind, day, e.txHash, e.nonce],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

export class MemoryLedger implements Ledger {
  readonly rows: (LedgerEntry & { day: string })[] = [];
  async record(e: LedgerEntry, now: Date): Promise<void> {
    const day = utcDay(now);
    const used = this.rows.filter((r) => r.agentId === e.agentId && r.channel === e.channel && r.day === day).length;
    if (used >= e.cap) throw new Rejection('signature_cap_reached', `${e.channel} signature cap of ${e.cap}/day reached`);
    if (this.rows.some((r) => r.txHash === e.txHash)) throw new Error('duplicate tx hash');
    this.rows.push({ ...e, day });
  }
}
