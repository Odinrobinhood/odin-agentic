import { Rejection } from '@odin/shared';
import type { Pool } from '@odin/db';

export type Channel = 'agent' | 'guard';

export type LedgerEntry = {
  agentId: string;
  channel: Channel;
  kind: 'approve' | 'swap' | 'withdraw';
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
  /** Burn a key-export nonce; false if it was already used. */
  burnExportNonce(nonce: string, agentId: string): Promise<boolean>;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class PgLedger implements Ledger {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async burnExportNonce(nonce: string, agentId: string): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO signer.exports (nonce, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [nonce, agentId]);
    return r.rowCount === 1;
  }

  async record(e: LedgerEntry, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // serialise all signatures of one agent+channel so the count cannot race
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${e.agentId}:${e.channel}`]);
      // re-signing byte-identical tx data yields the same hash: idempotent, not a new signature
      const seen = await client.query('SELECT 1 FROM signer.signatures WHERE tx_hash = $1 AND agent_id = $2', [e.txHash, e.agentId]);
      if (seen.rowCount) {
        await client.query('COMMIT');
        return;
      }
      const day = utcDay(now);
      const used = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM signer.signatures WHERE agent_id = $1 AND channel = $2 AND day = $3',
        [e.agentId, e.channel, day],
      );
      if (Number(used.rows[0]?.n ?? 0) >= e.cap) {
        throw new Rejection('signature_cap_reached', `${e.channel} signature cap of ${e.cap}/day reached`);
      }
      await client.query(
        'INSERT INTO signer.signatures (agent_id, channel, kind, day, tx_hash, nonce) VALUES ($1, $2, $3, $4, $5, $6)',
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
  readonly exportNonces = new Set<string>();
  async burnExportNonce(nonce: string): Promise<boolean> {
    if (this.exportNonces.has(nonce)) return false;
    this.exportNonces.add(nonce);
    return true;
  }
  async record(e: LedgerEntry, now: Date): Promise<void> {
    if (this.rows.some((r) => r.txHash === e.txHash && r.agentId === e.agentId)) return;
    const day = utcDay(now);
    const used = this.rows.filter((r) => r.agentId === e.agentId && r.channel === e.channel && r.day === day).length;
    if (used >= e.cap) throw new Rejection('signature_cap_reached', `${e.channel} signature cap of ${e.cap}/day reached`);
    this.rows.push({ ...e, day });
  }
}
