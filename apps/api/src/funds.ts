import { randomBytes } from 'node:crypto';
import { getAddress, parseUnits, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Pool } from '@odin/db';
import { EXPORT_MAX_TTL_SECONDS, Rejection, exportKeyMessage, type RejectionCode } from '@odin/shared';

export const WithdrawInput = z
  .object({
    /** ERC-20 contract address, or "native" for ETH. */
    token: z.union([z.literal('native'), z.string().regex(/^0x[0-9a-fA-F]{40}$/)]),
    amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  })
  .strict();
export const ExportInput = z.object({ message: z.string().max(1000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).strict();
export const CloseAllInput = z.object({ mode: z.enum(['paper', 'live']).optional() }).strict();

export interface WithdrawExecutor {
  executeWithdraw(job: { agentId: string; wallet: Address; token: Address | null; amount: bigint }): Promise<{
    status: string; txHash?: Hex; code?: RejectionCode; message?: string; recipient?: Address;
  }>;
}

export interface KeyExporter {
  /** POST /v1/export on the signer's agent channel; the signer verifies the owner's signature itself. */
  exportKey(req: { agentId: string; message: string; signature: Hex }): Promise<{ address: Address; privateKey: Hex }>;
}

export type FundsDeps = { pool: Pool; executor: WithdrawExecutor; exporter: KeyExporter; chainId: number; readDecimals: (token: Address) => Promise<number> };

/**
 * Money leaving the agent (architecture §6): withdrawals go only to the owner's SIWE wallet (the signer
 * chooses the recipient), key export needs the owner's signature verified by the signer, and closing all
 * positions is queued for the guard watcher, which holds the guard channel.
 */
export class FundsService {
  private readonly d: FundsDeps;
  constructor(deps: FundsDeps) {
    this.d = deps;
  }

  async withdraw(agentId: string, input: z.infer<typeof WithdrawInput>) {
    const w = await this.d.pool.query<{ address: string; owner: string }>(
      `SELECT w.address, u.wallet_address AS owner FROM agent_wallets w JOIN agents a ON a.id = w.agent_id JOIN users u ON u.id = a.user_id WHERE w.agent_id = $1`,
      [agentId],
    );
    if (!w.rows[0]) throw new Rejection('unknown_agent', 'agent has no wallet');
    const token = input.token === 'native' ? null : getAddress(input.token);
    const decimals = token === null ? 18 : await this.decimals(token);
    const amount = parseUnits(input.amount, decimals);
    if (amount === 0n) throw new Rejection('amount_invalid', 'amount must be > 0');

    const row = await this.d.pool.query<{ id: string }>(
      `INSERT INTO withdrawals (agent_id, token, amount, recipient) VALUES ($1, $2, $3, $4) RETURNING id`,
      [agentId, token?.toLowerCase() ?? null, amount.toString(), w.rows[0].owner],
    );
    const id = row.rows[0]!.id;
    let out: Awaited<ReturnType<WithdrawExecutor['executeWithdraw']>>;
    try {
      out = await this.d.executor.executeWithdraw({ agentId, wallet: getAddress(w.rows[0].address), token, amount });
    } catch (e) {
      // never leave the row pending forever
      out = { status: 'rejected', code: e instanceof Rejection ? e.code : 'internal_error', message: (e as Error).message.split('\n')[0] };
    }
    const status = out.status === 'confirmed' || out.status === 'reverted' || out.status === 'dropped' ? out.status : 'rejected';
    await this.d.pool.query(
      `UPDATE withdrawals SET status = $2, tx_hash = $3, error_code = $4, error = $5, updated_at = now() WHERE id = $1`,
      [id, status, out.txHash ?? null, out.code ?? null, out.message?.slice(0, 1000) ?? null],
    );
    return { id, status, txHash: out.txHash ?? null, recipient: getAddress(w.rows[0].owner), amount: amount.toString(), token: token ?? 'native', ...(out.code ? { error: { code: out.code, message: out.message } } : {}) };
  }

  async withdrawals(agentId: string) {
    return (await this.d.pool.query(`SELECT * FROM withdrawals WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`, [agentId])).rows;
  }

  /** The exact text the owner must sign; the signer re-parses and verifies it. */
  async exportMessage(agentId: string, now = new Date()) {
    const w = await this.d.pool.query<{ address: string }>('SELECT address FROM agent_wallets WHERE agent_id = $1', [agentId]);
    if (!w.rows[0]) throw new Rejection('unknown_agent', 'agent has no wallet');
    const expiresAt = new Date(now.getTime() + Math.min(300, EXPORT_MAX_TTL_SECONDS) * 1000);
    expiresAt.setMilliseconds(0);
    return { message: exportKeyMessage({ wallet: getAddress(w.rows[0].address), agentId, chainId: this.d.chainId, nonce: randomBytes(16).toString('hex'), expiresAt }), expiresAt };
  }

  async exportKey(agentId: string, input: z.infer<typeof ExportInput>) {
    const out = await this.d.exporter.exportKey({ agentId, message: input.message, signature: input.signature as Hex });
    await this.d.pool.query('UPDATE agent_wallets SET exported_at = now() WHERE agent_id = $1', [agentId]);
    return out;
  }

  async closeAll(agentId: string, status: string, agentMode: string, mode?: 'paper' | 'live') {
    if (status !== 'active' && status !== 'paused') throw new Rejection('bad_request', `cannot close positions of a ${status} agent; withdraw the tokens instead`);
    // one open request per agent and mode: repeated clicks return the pending one instead of queueing more
    const open = await this.d.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM close_requests WHERE agent_id = $1 AND mode = $2 AND status IN ('pending', 'processing') LIMIT 1`,
      [agentId, mode ?? agentMode],
    );
    if (open.rows[0]) return { requestId: open.rows[0].id, status: open.rows[0].status };
    const r = await this.d.pool.query<{ id: string }>(`INSERT INTO close_requests (agent_id, mode) VALUES ($1, $2) RETURNING id`, [agentId, mode ?? agentMode]);
    return { requestId: r.rows[0]!.id, status: 'pending' };
  }

  async closeRequest(agentId: string, requestId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Rejection('bad_request', 'bad request id');
    const r = await this.d.pool.query(`SELECT id, mode, status, result, requested_at, processed_at FROM close_requests WHERE id = $1 AND agent_id = $2`, [requestId, agentId]);
    if (!r.rows[0]) throw new Rejection('bad_request', 'unknown close request');
    return r.rows[0];
  }

  private async decimals(token: Address): Promise<number> {
    const t = await this.d.pool.query<{ decimals: number }>('SELECT decimals FROM tokens WHERE address = $1', [token.toLowerCase()]);
    return t.rows[0]?.decimals ?? (await this.d.readDecimals(token));
  }
}
