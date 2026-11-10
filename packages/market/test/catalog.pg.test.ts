import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { createPool, type Pool } from '@odin/db';
import { CatalogEnricher, PoolDiscovery, searchCatalog, type CreatedPool, type DiscoveryChain } from '../src/catalog.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;
const rnd = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

describe.skipIf(!url)('token catalog (postgres)', () => {
  let pool: Pool;
  const FACTORY = rnd();
  const USDG = rnd();
  const WETH = rnd();
  const REAL = rnd(); // deep pool against USDG
  const FAKE = rnd(); // copies REAL's symbol, shallow WETH pool
  const ORPHAN = rnd(); // only paired with another random token
  const OTHER = rnd();
  const created: CreatedPool[] = [
    { pool: rnd(), token0: REAL, token1: USDG, fee: 3000, block: 150n },
    { pool: rnd(), token0: FAKE, token1: WETH, fee: 10000, block: 4_000n },
    { pool: rnd(), token0: ORPHAN, token1: OTHER, fee: 500, block: 9_000n },
  ];
  const balances = new Map<string, bigint>([[`${USDG}:${created[0]!.pool}`, 50_000n * 10n ** 6n], [`${WETH}:${created[1]!.pool}`, 10n ** 16n]]);
  let refusals = 0;
  const chain: DiscoveryChain = {
    head: async () => 10_020n,
    hasCode: async (_a, at) => at >= 100n,
    poolCreated: async (_f, from, to) => {
      if (to - from > 2_000n && refusals < 2) {
        refusals++;
        throw new Error('query returned more than 10000 results / block range too large');
      }
      return created.filter((p) => p.block >= from && p.block <= to);
    },
    balances: async (pairs) => pairs.map((p) => balances.get(`${p.token}:${p.holder}`) ?? 0n),
    facts: async (tokens) => tokens.map((t) => { const m = meta.get(t); return m ? { ...m, stock: false } : { decimals: null, symbol: '', name: '', stock: false }; }),
  };
  const meta = new Map<string, { decimals: number | null; symbol: unknown; name: unknown }>([
    [REAL, { decimals: 18, symbol: 'ROBO', name: 'Robo Token' }],
    [FAKE, { decimals: 18, symbol: 'ROBO', name: 'Robo Token‮ (official)' }],
    [ORPHAN, { decimals: 9, symbol: 'ORPH', name: 'Orphan' }],
    [OTHER, { decimals: 18, symbol: 'OTH', name: 'Other' }],
    [USDG, { decimals: 6, symbol: 'USDG', name: 'Global Dollar' }],
    [WETH, { decimals: 18, symbol: 'WETH', name: 'Wrapped Ether' }],
  ]);

  beforeAll(async () => {
    pool = createPool(url!, { max: 4 });
    await pool.query("INSERT INTO market_snapshots (ts, token_address, pool, fee_tier, price) VALUES (now(), $1, $2, 500, 2000)", [WETH.toLowerCase(), rnd().toLowerCase()]);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('discovers every pool from the factory deployment block, shrinking refused log ranges', async () => {
    const d = new PoolDiscovery({ pool, chain, factory: FACTORY, batchBlocks: 100_000n });
    let r;
    do r = await d.step();
    while (!r.caughtUp);
    expect(refusals).toBe(2);
    const n = await pool.query('SELECT count(*)::int AS n FROM discovered_pools WHERE pool = ANY($1)', [created.map((p) => p.pool.toLowerCase())]);
    expect(n.rows[0].n).toBe(3);
    const s = await pool.query('SELECT start_block FROM indexer_state WHERE stream = $1', [`pools:${FACTORY.toLowerCase()}`]);
    expect(s.rows[0].start_block).toBe('100');
  });

  it('enriches tokens: sanitized labels, tradability via USDG/WETH, depth; search flags copied symbols', async () => {
    const e = new CatalogEnricher({ pool, chain, usdg: USDG, weth: WETH, minDepthUsdg: 10 });
    while ((await e.step(50, 50)) > 0);
    const rows = await searchCatalog(pool, 'ROBO');
    expect(rows.map((r: { address: string }) => getAddress(r.address))).toEqual([REAL, FAKE]); // deepest first
    expect(rows[0]).toMatchObject({ tradable: true, depth_usdg: 50_000, symbol_shadowed: false });
    expect(rows[1]).toMatchObject({ tradable: true, symbol_shadowed: true, name: 'Robo Token (official)' });
    expect(rows[1].depth_usdg).toBeCloseTo(20, 6); // 0.01 WETH * 2000
    // no USDG/WETH pool: not routable, so not catalogued (still addable by pasting the address)
    expect(await searchCatalog(pool, ORPHAN)).toEqual([]);
    expect(await searchCatalog(pool, '%')).toEqual(await searchCatalog(pool, '')); // LIKE wildcards are stripped
  });
});
