import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { createPool, type Pool } from '@odin/db';
import { encodePath } from '@odin/shared';
import { PgMarketStore } from '../src/store.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;
const rnd = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

describe.skipIf(!url)('PgMarketStore (postgres)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(url!, { max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('round-trips tokens, routes (pools as a real array) and snapshots', async () => {
    const store = new PgMarketStore(pool);
    const [a, q, p] = [rnd(), rnd(), rnd()];
    await store.upsertToken({ address: a, decimals: 18, symbol: 'A', name: 'A', isStockToken: true });
    await store.upsertToken({ address: q, decimals: 6, symbol: 'Q', name: 'Q', isStockToken: false });
    const path = encodePath([a, q], [500]);
    await store.replaceRoutes(a, [{ quote: q, path, pools: [p] }]);
    const r = (await store.routes()).find((x) => x.token === a)!;
    expect(r.pools).toEqual([p]);
    expect(r.tokens).toEqual([a, q]);
    expect(r.path).toBe(path.toLowerCase());
    await store.insertSnapshots([{ ts: new Date(), token: a, pool: p, feeTier: 500, price: 1.5, oraclePrice: null }]);
    const s = await pool.query('SELECT price FROM market_snapshots WHERE token_address = $1', [a.toLowerCase()]);
    expect(Number(s.rows[0].price)).toBe(1.5);
    expect((await store.getToken(a))!.isStockToken).toBe(true);
  });
});
