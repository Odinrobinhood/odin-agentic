import type { Address, Hex } from 'viem';
import type { Pool } from '@odin/db';

export type ExecStatus = 'signed' | 'broadcast' | 'confirmed' | 'reverted' | 'dropped' | 'expired';
export const INFLIGHT: ExecStatus[] = ['signed', 'broadcast'];
/** Statuses whose nonce is (or may be) used on chain. Dropped and expired executions free their nonce. */
export const NONCE_HOLDING: ExecStatus[] = ['signed', 'broadcast', 'confirmed', 'reverted'];

export type NewExecution = {
  decisionId: string;
  wallet: Address;
  channel: 'agent' | 'guard';
  kind: 'approve' | 'swap';
  txHash: Hex;
  nonce: number;
  deadline: Date | null;
};

export type ExecutionPatch = {
  status: ExecStatus;
  rpc?: string;
  errorCode?: string;
  error?: string;
  block?: bigint;
  gasUsed?: bigint;
  amountIn?: bigint;
  amountOut?: bigint;
};

export type InflightRow = { txHash: Hex; wallet: Address; kind: 'approve' | 'swap'; nonce: number; deadline: Date | null; createdAt: Date };

export interface ExecutionStore {
  /**
   * Reserve the next nonce for `wallet` under a per-wallet lock, run `sign(nonce)`, and record the signed
   * execution — all atomically. If `sign` throws, nothing is recorded and the nonce is not consumed.
   *
   * next nonce = max(chain pending nonce, highest nonce-holding execution + 1). Confirmed/reverted ones
   * count too, so a lagging RPC's stale pending nonce cannot cause reuse. Dropped and expired executions
   * free their nonce, so a refused broadcast cannot leave a gap.
   */
  withNonce<T extends { txHash: Hex; deadline: Date | null }>(
    wallet: Address,
    chainPending: number,
    meta: Omit<NewExecution, 'txHash' | 'nonce' | 'deadline' | 'wallet'>,
    sign: (nonce: number) => Promise<T>,
  ): Promise<T & { nonce: number }>;
  update(txHash: Hex, patch: ExecutionPatch): Promise<void>;
  inflight(olderThan: Date): Promise<InflightRow[]>;
  /** Executions that consumed a nonce on chain (confirmed or reverted). */
  consumedCount(wallet: Address): Promise<number>;
}

export function nextNonce(chainPending: number, inflightMax: number | null): number {
  return inflightMax === null ? chainPending : Math.max(chainPending, inflightMax + 1);
}

export class PgExecutionStore implements ExecutionStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async withNonce<T extends { txHash: Hex; deadline: Date | null }>(
    wallet: Address,
    chainPending: number,
    meta: Omit<NewExecution, 'txHash' | 'nonce' | 'deadline' | 'wallet'>,
    sign: (nonce: number) => Promise<T>,
  ): Promise<T & { nonce: number }> {
    const w = wallet.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nonce:${w}`]);
      const r = await client.query<{ max: string | null }>(
        `SELECT max(nonce) AS max FROM executions WHERE wallet = $1 AND status = ANY($2) AND nonce >= $3`,
        [w, NONCE_HOLDING, chainPending],
      );
      const inflightMax = r.rows[0]?.max == null ? null : Number(r.rows[0].max);
      const nonce = nextNonce(chainPending, inflightMax);
      const signed = await sign(nonce);
      await client.query(
        `INSERT INTO executions (decision_id, wallet, channel, kind, tx_hash, nonce, deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'signed')
         ON CONFLICT (tx_hash) DO NOTHING`,
        [meta.decisionId, w, meta.channel, meta.kind, signed.txHash, nonce, signed.deadline],
      );
      await client.query(
        `INSERT INTO wallet_nonces (address, next_nonce) VALUES ($1, $2)
         ON CONFLICT (address) DO UPDATE SET next_nonce = EXCLUDED.next_nonce, updated_at = now()`,
        [w, nonce + 1],
      );
      await client.query('COMMIT');
      return { ...signed, nonce };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async update(txHash: Hex, p: ExecutionPatch): Promise<void> {
    await this.pool.query(
      `UPDATE executions SET status = $2, rpc = COALESCE($3, rpc), error_code = $4, error = $5,
              block = COALESCE($6, block), gas_used = COALESCE($7, gas_used),
              amount_in = COALESCE($8, amount_in), amount_out = COALESCE($9, amount_out), updated_at = now()
        WHERE tx_hash = $1`,
      [txHash, p.status, p.rpc ?? null, p.errorCode ?? null, p.error ?? null, p.block?.toString() ?? null,
        p.gasUsed?.toString() ?? null, p.amountIn?.toString() ?? null, p.amountOut?.toString() ?? null],
    );
  }

  async inflight(olderThan: Date): Promise<InflightRow[]> {
    const r = await this.pool.query<{ tx_hash: Hex; wallet: Address; kind: 'approve' | 'swap'; nonce: string; deadline: Date | null; created_at: Date }>(
      `SELECT tx_hash, wallet, kind, nonce, deadline, created_at FROM executions
        WHERE status = ANY($1) AND created_at < $2 ORDER BY wallet, nonce`,
      [INFLIGHT, olderThan],
    );
    return r.rows.map((x) => ({ txHash: x.tx_hash, wallet: x.wallet, kind: x.kind, nonce: Number(x.nonce), deadline: x.deadline, createdAt: x.created_at }));
  }

  async consumedCount(wallet: Address): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM executions WHERE wallet = $1 AND status IN ('confirmed', 'reverted')`,
      [wallet.toLowerCase()],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}

/** In-memory store for tests. Mirrors the Postgres semantics, including rollback on sign failure. */
export class MemoryExecutionStore implements ExecutionStore {
  readonly rows: (NewExecution & ExecutionPatch & { createdAt: Date })[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  async withNonce<T extends { txHash: Hex; deadline: Date | null }>(
    wallet: Address,
    chainPending: number,
    meta: Omit<NewExecution, 'txHash' | 'nonce' | 'deadline' | 'wallet'>,
    sign: (nonce: number) => Promise<T>,
  ): Promise<T & { nonce: number }> {
    const run = async () => {
      const live = this.rows.filter((r) => r.wallet === wallet && NONCE_HOLDING.includes(r.status) && r.nonce >= chainPending);
      const nonce = nextNonce(chainPending, live.length ? Math.max(...live.map((r) => r.nonce)) : null);
      const signed = await sign(nonce);
      if (!this.rows.some((r) => r.txHash === signed.txHash)) {
        this.rows.push({ ...meta, wallet, txHash: signed.txHash, nonce, deadline: signed.deadline, status: 'signed', createdAt: new Date() });
      }
      return { ...signed, nonce };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async update(txHash: Hex, patch: ExecutionPatch): Promise<void> {
    const r = this.rows.find((x) => x.txHash === txHash);
    if (r) Object.assign(r, patch);
  }

  async inflight(olderThan: Date): Promise<InflightRow[]> {
    return this.rows
      .filter((r) => INFLIGHT.includes(r.status) && r.createdAt < olderThan)
      .map((r) => ({ txHash: r.txHash, wallet: r.wallet, kind: r.kind, nonce: r.nonce, deadline: r.deadline, createdAt: r.createdAt }));
  }

  async consumedCount(wallet: Address): Promise<number> {
    return this.rows.filter((r) => r.wallet === wallet && (r.status === 'confirmed' || r.status === 'reverted')).length;
  }
}
