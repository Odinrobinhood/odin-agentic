import { createPublicClient, fallback, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';
import { EIP1967_BEACON_SLOT, ROBINHOOD_STOCK_BEACON, sanitizeName, sanitizeSymbol } from '@odin/shared';

/** PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) */
export const POOL_CREATED_TOPIC: Hex = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
/** Canonical Multicall3; its code is present on Robinhood Chain (checked 2026-11-10). */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

export type CreatedPool = { pool: Address; token0: Address; token1: Address; fee: number; block: bigint };
export type TokenFacts = { decimals: number | null; symbol: unknown; name: unknown; stock: boolean };

export interface DiscoveryChain {
  head(): Promise<bigint>;
  hasCode(address: Address, at: bigint): Promise<boolean>;
  poolCreated(factory: Address, from: bigint, to: bigint): Promise<CreatedPool[]>;
  /** balanceOf(holder) per (token, holder) pair, batched; a failed read is 0. */
  balances(pairs: { token: Address; holder: Address }[]): Promise<bigint[]>;
  /** decimals / symbol / name and the Stock Token controls, batched; unreadable fields are null / ''. */
  facts(tokens: Address[]): Promise<TokenFacts[]>;
}

const word = (t: string | undefined) => getAddress(`0x${(t ?? '').slice(-40)}`);
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function paused() view returns (bool)',
  'function tokenPaused() view returns (bool)',
]);

export class ViemDiscoveryChain implements DiscoveryChain {
  private readonly c;
  constructor(rpcUrls: string[]) {
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 30_000, retryCount: 1 })), { rank: false }) });
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
  async balances(pairs: { token: Address; holder: Address }[]) {
    const r = await this.c.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      batchSize: 16_384,
      contracts: pairs.map((p) => ({ address: p.token, abi: erc20, functionName: 'balanceOf' as const, args: [p.holder] as const })),
    });
    return r.map((x) => (x.status === 'success' ? (x.result as bigint) : 0n));
  }
  async facts(tokens: Address[]) {
    const calls = tokens.flatMap((t) => [
      { address: t, abi: erc20, functionName: 'decimals' as const },
      { address: t, abi: erc20, functionName: 'symbol' as const },
      { address: t, abi: erc20, functionName: 'name' as const },
      { address: t, abi: erc20, functionName: 'paused' as const },
      { address: t, abi: erc20, functionName: 'tokenPaused' as const },
    ]);
    // mixed return types across the five calls: read results untyped and narrow per field below
    const r = (await this.c.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 16_384, contracts: calls } as never)) as { status: 'success' | 'failure'; result?: unknown }[];
    const out = tokens.map((_, i) => {
      const [dec, sym, nam, paused, tokenPaused] = r.slice(i * 5, i * 5 + 5);
      return {
        decimals: dec?.status === 'success' ? Number(dec.result) : null,
        symbol: sym?.status === 'success' ? sym.result : '',
        name: nam?.status === 'success' ? nam.result : '',
        stock: paused?.status === 'success' && tokenPaused?.status === 'success',
      };
    });
    // exposing the controls is not proof (anyone can deploy them): only Robinhood beacon proxies are Stock Tokens
    for (let i = 0; i < tokens.length; i++) {
      if (!out[i]!.stock) continue;
      const slot = await this.c.getStorageAt({ address: tokens[i]!, slot: EIP1967_BEACON_SLOT }).catch(() => undefined);
      out[i]!.stock = !!slot && `0x${slot.slice(26)}`.toLowerCase() === ROBINHOOD_STOCK_BEACON;
    }
    return out;
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
    for (let i = 0; i < logs.length; i += 1000) {
      const chunk = logs.slice(i, i + 1000);
      await this.pool.query(
        `INSERT INTO discovered_pools (pool, token0, token1, fee, created_block)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::bigint[]) ON CONFLICT DO NOTHING`,
        [chunk.map((p) => p.pool.toLowerCase()), chunk.map((p) => p.token0.toLowerCase()), chunk.map((p) => p.token1.toLowerCase()), chunk.map((p) => p.fee), chunk.map((p) => p.block.toString())],
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
 * Catalog enrichment in two phases. (A) Depth: for every token with a USDG or WETH pool, the base-asset
 * balance held by those pools, read in large multicall batches and valued in USDG; refreshed daily.
 * (B) Metadata (sanitized labels, Stock Token probe) only for tokens at or above `minDepthUsdg`, so tens of
 * thousands of empty launchpad tokens do not cost metadata reads. Nothing here limits what a user may
 * pick: any token can still be added by address.
 */
export class CatalogEnricher {
  private readonly pool: Pool;
  private readonly chain: DiscoveryChain;
  private readonly usdg: Address;
  private readonly weth: Address;
  private readonly minDepthUsdg: number;

  constructor(deps: { pool: Pool; chain: DiscoveryChain; usdg: Address; weth: Address; minDepthUsdg?: number }) {
    this.pool = deps.pool;
    this.chain = deps.chain;
    this.usdg = deps.usdg;
    this.weth = deps.weth;
    this.minDepthUsdg = deps.minDepthUsdg ?? 10;
  }

  /** Returns how many tokens were processed (0 = nothing due). */
  async step(depthBatch = 2000, metaBatch = 200): Promise<number> {
    return (await this.depthPhase(depthBatch)) + (await this.metaPhase(metaBatch));
  }

  private async depthPhase(limit: number): Promise<number> {
    const u = this.usdg.toLowerCase();
    const w = this.weth.toLowerCase();
    // tokens with a base pool whose depth is missing or older than a day
    const due = await this.pool.query<{ token: string }>(
      `SELECT x.token FROM (
          SELECT DISTINCT CASE WHEN token0 IN ($1, $2) THEN token1 ELSE token0 END AS token
            FROM discovered_pools WHERE token0 IN ($1, $2) OR token1 IN ($1, $2)) x
         LEFT JOIN token_catalog c ON c.address = x.token
        WHERE c.depth_checked_at IS NULL OR c.depth_checked_at < now() - interval '1 day'
        ORDER BY c.depth_checked_at NULLS FIRST LIMIT $3`,
      [u, w, limit],
    );
    if (!due.rowCount) return 0;
    const tokens = due.rows.map((r) => r.token);
    const pools = await this.pool.query<{ pool: string; token0: string; token1: string }>(
      `SELECT pool, token0, token1 FROM discovered_pools
        WHERE (token0 = ANY($1) AND token1 IN ($2, $3)) OR (token1 = ANY($1) AND token0 IN ($2, $3))`,
      [tokens, u, w],
    );
    const pairs = pools.rows.map((p) => {
      const base = p.token0 === u || p.token0 === w ? p.token0 : p.token1;
      return { token: getAddress(base), holder: getAddress(p.pool), subject: base === p.token0 ? p.token1 : p.token0 };
    });
    const bal = await this.chain.balances(pairs);
    const wp = await this.pool.query<{ price: string }>('SELECT price FROM market_snapshots WHERE token_address = $1 ORDER BY ts DESC LIMIT 1', [w]);
    const wethUsdg = wp.rows[0] ? Number(wp.rows[0].price) : 0;
    const depth = new Map<string, { usdg: number; pools: number }>();
    pairs.forEach((p, i) => {
      const v = p.token.toLowerCase() === u ? Number(bal[i]!) / 1e6 : (Number(bal[i]!) / 1e18) * wethUsdg;
      const d = depth.get(p.subject) ?? { usdg: 0, pools: 0 };
      depth.set(p.subject, { usdg: d.usdg + v, pools: d.pools + 1 });
    });
    await this.pool.query(
      `INSERT INTO token_catalog (address, tradable, depth_usdg, pools, depth_checked_at)
       SELECT a, true, d, n, now() FROM unnest($1::text[], $2::numeric[], $3::int[]) AS t(a, d, n)
       ON CONFLICT (address) DO UPDATE SET tradable = true, depth_usdg = EXCLUDED.depth_usdg, pools = EXCLUDED.pools, depth_checked_at = now()`,
      [tokens, tokens.map((t) => depth.get(t)?.usdg ?? 0), tokens.map((t) => depth.get(t)?.pools ?? 0)],
    );
    return tokens.length;
  }

  private async metaPhase(limit: number): Promise<number> {
    const due = await this.pool.query<{ address: string }>(
      `SELECT address FROM token_catalog
        WHERE depth_usdg >= $1 AND (meta_at IS NULL OR meta_at < now() - interval '7 days')
        ORDER BY depth_usdg DESC LIMIT $2`,
      [this.minDepthUsdg, limit],
    );
    if (!due.rowCount) return 0;
    const tokens = due.rows.map((r) => getAddress(r.address));
    const facts = await this.chain.facts(tokens);
    for (let i = 0; i < tokens.length; i++) {
      const f = facts[i]!;
      const ok = f.decimals !== null && f.decimals <= 77;
      await this.pool.query(
        `UPDATE token_catalog SET symbol = $2, name = $3, decimals = $4, is_stock_token = $5, error = $6, meta_at = now(), enriched_at = now() WHERE address = $1`,
        [tokens[i]!.toLowerCase(), sanitizeSymbol(f.symbol), sanitizeName(f.name), ok ? f.decimals : null, f.stock, ok ? null : 'not a readable ERC-20 (no decimals())'],
      );
    }
    return tokens.length;
  }
}

/**
 * Search the catalog by symbol, name or address. Only tokens with metadata are listed by symbol/name; an
 * exact address always resolves. Flags a token whose symbol is also used by a deeper token, because
 * symbols can be copied by anyone (identity is the address).
 */
export async function searchCatalog(pool: Pool, q: string, limit = 25) {
  const term = q.trim();
  const byAddress = /^0x[0-9a-fA-F]{40}$/.test(term);
  const r = await pool.query(
    `SELECT c.address, c.symbol, c.name, c.decimals, c.is_stock_token, c.tradable, c.depth_usdg::float AS depth_usdg, c.pools,
            (t.address IS NOT NULL) AS registered,
            EXISTS (SELECT 1 FROM token_catalog o WHERE c.symbol <> '' AND upper(o.symbol) = upper(c.symbol) AND o.address <> c.address
                     AND COALESCE(o.depth_usdg, 0) > COALESCE(c.depth_usdg, 0)) AS symbol_shadowed
       FROM token_catalog c LEFT JOIN tokens t ON t.address = c.address
      WHERE c.error IS NULL AND (
            ($1 AND c.address = lower($2))
         OR (NOT $1 AND c.meta_at IS NOT NULL AND ($2 = '' OR upper(c.symbol) LIKE upper($2) || '%' OR c.name ILIKE '%' || $2 || '%')))
      ORDER BY c.tradable DESC, c.depth_usdg DESC NULLS LAST LIMIT $3`,
    [byAddress, term.replace(/[%_\\]/g, ''), Math.min(Math.max(limit, 1), 100)],
  );
  return r.rows;
}
