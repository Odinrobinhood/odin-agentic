import { createPublicClient, fallback, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';
import { sanitizeName, sanitizeSymbol } from '@odin/shared';
import type { MarketChain } from './chain.ts';

/** PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) */
export const POOL_CREATED_TOPIC: Hex = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';

export type CreatedPool = { pool: Address; token0: Address; token1: Address; fee: number; block: bigint };

export interface DiscoveryChain {
  head(): Promise<bigint>;
  hasCode(address: Address, at: bigint): Promise<boolean>;
  poolCreated(factory: Address, from: bigint, to: bigint): Promise<CreatedPool[]>;
  balanceOf(token: Address, holder: Address): Promise<bigint>;
}

const word = (t: string | undefined) => getAddress(`0x${(t ?? '').slice(-40)}`);

export class ViemDiscoveryChain implements DiscoveryChain {
  private readonly c;
  constructor(rpcUrls: string[]) {
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 20_000, retryCount: 1 })), { rank: false }) });
  }
  head() {
    return this.c.getBlockNumber();
  }
  async hasCode(address: Address, at: bigint) {
    const code = await this.c.getCode({ address, blockNumber: at });
    return !!code && code !== '0x';
  }
  async poolCreated(factory: Address, from: bigint, to: bigint): Promise<CreatedPool[]> {
    const raw = (await this.c.request({
      method: 'eth_getLogs',
      params: [{ address: factory, topics: [POOL_CREATED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    })) as { topics: Hex[]; data: Hex; blockNumber: Hex }[];
    return raw
      .filter((l) => l.topics.length === 4 && l.data.length >= 2 + 128)
      .map((l) => ({ token0: word(l.topics[1]), token1: word(l.topics[2]), fee: Number(BigInt(l.topics[3]!)), pool: word(`0x${l.data.slice(66, 130)}`), block: BigInt(l.blockNumber) }));
  }
  balanceOf(token: Address, holder: Address) {
    return this.c.readContract({ address: token, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [holder] });
  }
}

/**
 * Pool discovery: follows the pinned factory's PoolCreated events from its deployment block, so the
 * catalog holds every pool on Robinhood Chain. Log ranges shrink automatically when an RPC refuses them.
 */
export class PoolDiscovery {
  private readonly pool: Pool;
  private readonly chain: DiscoveryChain;
  private readonly factory: Address;
  private batch: bigint;

  constructor(deps: { pool: Pool; chain: DiscoveryChain; factory: Address; batchBlocks?: bigint }) {
    this.pool = deps.pool;
    this.chain = deps.chain;
    this.factory = deps.factory;
    this.batch = deps.batchBlocks ?? 500_000n;
  }

  private get stream() {
    return `pools:${this.factory.toLowerCase()}`;
  }

  /** One batch. Returns the number of new pools and whether discovery has reached the head. */
  async step(): Promise<{ found: number; caughtUp: boolean; toBlock: bigint }> {
    const head = (await this.chain.head()) - 20n;
    let cur = await this.pool.query<{ last_block: string }>('SELECT last_block FROM indexer_state WHERE stream = $1', [this.stream]);
    if (!cur.rows[0]) {
      const start = await deploymentBlock(this.chain, this.factory, head);
      await this.pool.query(
        `INSERT INTO indexer_state (stream, contract, start_block, last_block, last_block_hash) VALUES ($1, $2, $3, $4, '0x') ON CONFLICT DO NOTHING`,
        [this.stream, this.factory.toLowerCase(), start.toString(), (start - 1n).toString()],
      );
      cur = await this.pool.query('SELECT last_block FROM indexer_state WHERE stream = $1', [this.stream]);
    }
    const last = BigInt(cur.rows[0]!.last_block);
    if (last >= head) return { found: 0, caughtUp: true, toBlock: last };
    const from = last + 1n;
    let to = from + this.batch - 1n < head ? from + this.batch - 1n : head;
    let logs: CreatedPool[] | null = null;
    for (let attempt = 0; attempt < 6 && logs === null; attempt++) {
      try {
        logs = await this.chain.poolCreated(this.factory, from, to);
      } catch (e) {
        if (to === from) throw e;
        // range too large for this RPC: shrink and remember
        this.batch = this.batch / 4n > 1000n ? this.batch / 4n : 1000n;
        to = from + this.batch - 1n < head ? from + this.batch - 1n : head;
      }
    }
    if (logs === null) throw new Error('eth_getLogs keeps failing for PoolCreated');
    for (const p of logs) {
      await this.pool.query(
        `INSERT INTO discovered_pools (pool, token0, token1, fee, created_block) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [p.pool.toLowerCase(), p.token0.toLowerCase(), p.token1.toLowerCase(), p.fee, p.block.toString()],
      );
    }
    await this.pool.query('UPDATE indexer_state SET last_block = $2, updated_at = now() WHERE stream = $1', [this.stream, to.toString()]);
    return { found: logs.length, caughtUp: to >= head, toBlock: to };
  }
}

async function deploymentBlock(chain: DiscoveryChain, address: Address, head: bigint): Promise<bigint> {
  if (!(await chain.hasCode(address, head))) throw new Error(`factory ${address} has no code`);
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await chain.hasCode(address, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Catalog enrichment: metadata (sanitized), Stock Token probe, tradability (has a USDG or WETH pool) and a
 * depth hint for every discovered token. Stale rows are refreshed daily. Nothing here limits what a user
 * may pick; it only makes every token findable.
 */
export class CatalogEnricher {
  private readonly pool: Pool;
  private readonly chain: DiscoveryChain;
  private readonly market: Pick<MarketChain, 'tokenMeta' | 'hasStockControls'>;
  private readonly usdg: Address;
  private readonly weth: Address;

  constructor(deps: { pool: Pool; chain: DiscoveryChain; market: Pick<MarketChain, 'tokenMeta' | 'hasStockControls'>; usdg: Address; weth: Address }) {
    this.pool = deps.pool;
    this.chain = deps.chain;
    this.market = deps.market;
    this.usdg = deps.usdg;
    this.weth = deps.weth;
  }

  async step(limit = 25): Promise<number> {
    const due = await this.pool.query<{ token: string }>(
      `SELECT t.token FROM (SELECT token0 AS token FROM discovered_pools UNION SELECT token1 FROM discovered_pools) t
         LEFT JOIN token_catalog c ON c.address = t.token
        WHERE c.address IS NULL OR c.enriched_at < now() - interval '1 day'
        ORDER BY c.enriched_at NULLS FIRST LIMIT $1`,
      [limit],
    );
    const wethPrice = await this.pool.query<{ price: string }>('SELECT price FROM market_snapshots WHERE token_address = $1 ORDER BY ts DESC LIMIT 1', [this.weth.toLowerCase()]);
    const wethUsdg = wethPrice.rows[0] ? Number(wethPrice.rows[0].price) : null;
    for (const { token } of due.rows) await this.enrich(getAddress(token), wethUsdg);
    return due.rows.length;
  }

  private async enrich(token: Address, wethUsdg: number | null) {
    const pools = await this.pool.query<{ pool: string; token0: string; token1: string }>(
      'SELECT pool, token0, token1 FROM discovered_pools WHERE token0 = $1 OR token1 = $1',
      [token.toLowerCase()],
    );
    let meta;
    try {
      meta = await this.market.tokenMeta(token);
    } catch (e) {
      await this.save(token, { symbol: '', name: '', decimals: null, stock: false, tradable: false, depth: null, pools: pools.rowCount ?? 0, error: `not a readable ERC-20: ${(e as Error).message.split('\n')[0]}` });
      return;
    }
    const isBase = token === this.usdg || token === this.weth;
    let depth = 0;
    let tradable = isBase;
    for (const p of pools.rows) {
      const other = getAddress(p.token0 === token.toLowerCase() ? p.token1 : p.token0);
      if (other !== this.usdg && other !== this.weth) continue;
      tradable = true;
      const bal = await this.chain.balanceOf(other, getAddress(p.pool)).catch(() => 0n);
      depth += other === this.usdg ? Number(bal) / 1e6 : wethUsdg === null ? 0 : (Number(bal) / 1e18) * wethUsdg;
    }
    await this.save(token, {
      symbol: sanitizeSymbol(meta.symbol), name: sanitizeName(meta.name), decimals: meta.decimals,
      stock: await this.market.hasStockControls(token), tradable, depth: tradable ? depth : null, pools: pools.rowCount ?? 0, error: null,
    });
  }

  private async save(token: Address, r: { symbol: string; name: string; decimals: number | null; stock: boolean; tradable: boolean; depth: number | null; pools: number; error: string | null }) {
    await this.pool.query(
      `INSERT INTO token_catalog (address, symbol, name, decimals, is_stock_token, tradable, depth_usdg, pools, error, enriched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (address) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals,
         is_stock_token = EXCLUDED.is_stock_token, tradable = EXCLUDED.tradable, depth_usdg = EXCLUDED.depth_usdg,
         pools = EXCLUDED.pools, error = EXCLUDED.error, enriched_at = now()`,
      [token.toLowerCase(), r.symbol, r.name, r.decimals, r.stock, r.tradable, r.depth, r.pools, r.error],
    );
  }
}

/**
 * Search the catalog by symbol, name or address. Flags a token whose symbol is also used by a deeper
 * token, because symbols can be copied by anyone (identity is the address).
 */
export async function searchCatalog(pool: Pool, q: string, limit = 25) {
  const term = q.trim();
  const byAddress = /^0x[0-9a-fA-F]{40}$/.test(term);
  const r = await pool.query(
    `SELECT c.address, c.symbol, c.name, c.decimals, c.is_stock_token, c.tradable, c.depth_usdg::float AS depth_usdg, c.pools,
            (t.address IS NOT NULL) AS registered,
            EXISTS (SELECT 1 FROM token_catalog o WHERE upper(o.symbol) = upper(c.symbol) AND o.address <> c.address
                     AND COALESCE(o.depth_usdg, 0) > COALESCE(c.depth_usdg, 0)) AS symbol_shadowed
       FROM token_catalog c LEFT JOIN tokens t ON t.address = c.address
      WHERE c.error IS NULL AND (
            ($1 AND c.address = lower($2))
         OR (NOT $1 AND ($2 = '' OR upper(c.symbol) LIKE upper($2) || '%' OR c.name ILIKE '%' || $2 || '%')))
      ORDER BY c.tradable DESC, c.depth_usdg DESC NULLS LAST LIMIT $3`,
    [byAddress, term.replace(/[%_\\]/g, ''), Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows;
}
