import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@odin/db';
import { Rejection } from '@odin/shared';
import { PgLedger } from '../src/ledger.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgLedger (postgres)', () => {
  let pool: Pool;
  let agentId: string;

  beforeAll(async () => {
    pool = createPool(url!, { max: 30 });
    const wallet = '0x' + randomUUID().replaceAll('-', '').padEnd(40, '0');
    const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [wallet]);
    const a = await pool.query<{ id: string }>("INSERT INTO agents (user_id, name) VALUES ($1, 'ledger-test') RETURNING id", [u.rows[0]!.id]);
    agentId = a.rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('never exceeds the cap under concurrent signing', async () => {
    const ledger = new PgLedger(pool);
    const now = new Date();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        ledger.record({ agentId, channel: 'agent', kind: 'swap', txHash: `0x${randomUUID()}${i}`, nonce: i, cap: 5 }, now),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const capped = results.filter((r) => r.status === 'rejected' && r.reason instanceof Rejection && r.reason.code === 'signature_cap_reached').length;
    expect(ok).toBe(5);
    expect(capped).toBe(15);
  });

  it('re-recording an identical tx hash is idempotent and does not consume quota', async () => {
    const ledger = new PgLedger(pool);
    const txHash = `0x${randomUUID()}`;
    const e = { agentId, channel: 'guard' as const, kind: 'approve' as const, txHash, nonce: 1, cap: 100 };
    await ledger.record(e, new Date());
    await expect(ledger.record(e, new Date())).resolves.toBeUndefined();
    const n = await pool.query('SELECT count(*)::int AS n FROM signer.signatures WHERE tx_hash = $1', [txHash]);
    expect(n.rows[0].n).toBe(1);
  });

  it('keeps the guard quota separate from the agent quota', async () => {
    const ledger = new PgLedger(pool);
    await expect(
      ledger.record({ agentId, channel: 'guard', kind: 'swap', txHash: `0x${randomUUID()}`, nonce: 99, cap: 5 }, new Date()),
    ).resolves.toBeUndefined();
  });

  it('re-checks status and mode inside the ledger transaction for trades, not for withdrawals', async () => {
    const ledger = new PgLedger(pool);
    const now = new Date();
    await pool.query("UPDATE agents SET status = 'paused', mode = 'live' WHERE id = $1", [agentId]);
    await expect(ledger.record({ agentId, channel: 'agent', kind: 'swap', txHash: `0x${randomUUID()}s`, nonce: 900, cap: 999, requireLive: ['active'] }, now)).rejects.toMatchObject({ code: 'agent_not_active' });
    await expect(ledger.record({ agentId, channel: 'guard', kind: 'swap', txHash: `0x${randomUUID()}g`, nonce: 901, cap: 999, requireLive: ['active', 'paused'] }, now)).resolves.toBeUndefined();
    await pool.query("UPDATE agents SET mode = 'paper' WHERE id = $1", [agentId]);
    await expect(ledger.record({ agentId, channel: 'guard', kind: 'swap', txHash: `0x${randomUUID()}p`, nonce: 902, cap: 999, requireLive: ['active', 'paused'] }, now)).rejects.toMatchObject({ code: 'agent_not_active' });
    await expect(ledger.record({ agentId, channel: 'agent', kind: 'withdraw', txHash: `0x${randomUUID()}w`, nonce: 903, cap: 999 }, now)).resolves.toBeUndefined();
  });
});
