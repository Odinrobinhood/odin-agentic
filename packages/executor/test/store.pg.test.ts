import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAddress, keccak256, toHex, type Address } from 'viem';
import { createPool, type Pool } from '@odin/db';
import { Rejection } from '@odin/shared';
import { PgExecutionStore } from '../src/store.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgExecutionStore (postgres)', () => {
  let pool: Pool;
  let decisionId: string;
  const wallet: Address = getAddress(`0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`);

  beforeAll(async () => {
    pool = createPool(url!, { max: 20 });
    const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [
      `0x${randomUUID().replaceAll('-', '').padEnd(40, '1')}`,
    ]);
    const a = await pool.query<{ id: string }>("INSERT INTO agents (user_id, name) VALUES ($1, 'exec-test') RETURNING id", [u.rows[0]!.id]);
    const d = await pool.query<{ id: string }>(
      "INSERT INTO decisions (agent_id, mode, origin, action) VALUES ($1, 'live', 'guard', 'sell') RETURNING id",
      [a.rows[0]!.id],
    );
    decisionId = d.rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const meta = () => ({ decisionId, channel: 'agent' as const, kind: 'swap' as const });
  const signer = (tag: string) => async () => ({ txHash: keccak256(toHex(`${tag}-${randomUUID()}`)), deadline: null });

  it('hands out distinct, gapless nonces under concurrency', async () => {
    const store = new PgExecutionStore(pool);
    const got = await Promise.all(Array.from({ length: 10 }, (_, i) => store.withNonce(wallet, 0, meta(), signer(`c${i}`))));
    expect(got.map((g) => g.nonce).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a failed signature rolls back and consumes nothing', async () => {
    const store = new PgExecutionStore(pool);
    await expect(
      store.withNonce(wallet, 0, meta(), async () => {
        throw new Rejection('token_paused', 'x');
      }),
    ).rejects.toThrow('x');
    const n = await store.withNonce(wallet, 0, meta(), signer('after'));
    expect(n.nonce).toBe(10);
  });

  it('dropped executions free their nonce', async () => {
    const store = new PgExecutionStore(pool);
    const last = await pool.query<{ tx_hash: `0x${string}` }>('SELECT tx_hash FROM executions WHERE wallet = $1 AND nonce = 10', [wallet.toLowerCase()]);
    await store.update(last.rows[0]!.tx_hash, { status: 'dropped', errorCode: 'broadcast_failed' });
    expect((await store.withNonce(wallet, 0, meta(), signer('reuse'))).nonce).toBe(10);
  });
});
