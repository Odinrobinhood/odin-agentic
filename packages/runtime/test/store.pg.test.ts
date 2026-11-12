import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPool, type Pool } from '@odin/db';
import { POSITION_UPSERT_SQL } from '../src/store.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('position booking (postgres)', () => {
  let pool: Pool;
  let agentId: string;
  let token: string;
  beforeAll(async () => {
    pool = createPool(url!, { max: 2 });
    const hex = () => `0x${randomBytes(20).toString('hex')}`;
    const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [hex()]);
    agentId = (await pool.query<{ id: string }>("INSERT INTO agents (user_id, name) VALUES ($1, 'pos-test') RETURNING id", [u.rows[0]!.id])).rows[0]!.id;
    token = hex();
    await pool.query("INSERT INTO tokens (address, decimals, symbol, name) VALUES ($1, 18, 'T', 'T')", [token]);
  });
  afterAll(async () => {
    await pool?.end();
  });

  const book = (qty: bigint, avg: number) => pool.query<{ qty: string; opened_at: Date | null }>(POSITION_UPSERT_SQL, [agentId, token, 'live', qty.toString(), avg, qty > 0n]).then((r) => r.rows[0]!);

  it('opens, keeps opened_at while adding, clears it on close and restarts it on reopen', async () => {
    const opened = await book(10n ** 18n, 2000);
    expect(opened.opened_at).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    const added = await book(2n * 10n ** 18n, 2010);
    expect(added.opened_at!.getTime()).toBe(opened.opened_at!.getTime());
    const closed = await book(0n, 0);
    expect(closed.qty).toBe('0');
    expect(closed.opened_at).toBeNull();
    const reopened = await book(5n * 10n ** 17n, 2020);
    expect(reopened.opened_at!.getTime()).toBeGreaterThan(opened.opened_at!.getTime());
  });
});
