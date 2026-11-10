import { createPublicClient, fallback, getAddress, http, isAddress, parseAbi, type Address } from 'viem';
import type { Pool } from '@odin/db';
import { sanitizeName, sanitizeSymbol } from '@odin/shared';

/** JSON-schema tool definitions (strict). The analyst answers ONLY through these (architecture §3.13). */
export const TOOL_DEFS = [
  {
    name: 'get_token',
    description: 'Look up a token on Robinhood Chain by contract address or symbol: metadata, Stock Token flag, routes and pools. Symbols are not unique; prefer addresses.',
    input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'Contract address (0x...) or symbol.' } } },
  },
  {
    name: 'get_price_history',
    description: 'OHLC candles in USDG from minute snapshots of the token\'s pools.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['token', 'period_minutes', 'count'],
      properties: { token: { type: 'string' }, period_minutes: { type: 'integer', description: '1 to 1440' }, count: { type: 'integer', description: '1 to 200' } },
    },
  },
  {
    name: 'get_pool_stats',
    description: 'Liquidity, fee tier and indexed swap volume/count over a window for each pool on the token\'s routes.',
    input_schema: { type: 'object', additionalProperties: false, required: ['token', 'hours'], properties: { token: { type: 'string' }, hours: { type: 'integer', description: '1 to 168' } } },
  },
  {
    name: 'get_flows',
    description: 'Net buy/sell pressure from indexed pool swaps and the largest transfers of the token over a window.',
    input_schema: { type: 'object', additionalProperties: false, required: ['token', 'hours'], properties: { token: { type: 'string' }, hours: { type: 'integer', description: '1 to 168' } } },
  },
  {
    name: 'get_holders',
    description: 'Largest holders among addresses active in the indexed window, with their CURRENT on-chain balances and share of supply. Not a full holder list.',
    input_schema: { type: 'object', additionalProperties: false, required: ['token', 'top'], properties: { token: { type: 'string' }, top: { type: 'integer', description: '1 to 25' } } },
  },
  {
    name: 'get_portfolio',
    description: 'The signed-in user\'s own portfolio: balances, USDG values and PnL across their wallet, agent wallets and watch-only wallets.',
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]['name'];

export type ToolDeps = {
  pool: Pool;
  rpcUrls: string[];
  usdg: Address;
  portfolio: (userId: string) => Promise<unknown>;
};

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)', 'function fee() view returns (uint24)', 'function token0() view returns (address)']);
const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number(v) || lo)));

/** Executes analyst tools. Every result carries its source and as-of point so answers can cite them. */
export class AnalystTools {
  private readonly d: ToolDeps;
  private readonly c;

  constructor(deps: ToolDeps) {
    this.d = deps;
    this.c = createPublicClient({ transport: fallback(deps.rpcUrls.map((u) => http(u, { timeout: 10_000 }))) });
  }

  async run(name: string, input: Record<string, unknown>, userId: string): Promise<Record<string, unknown>> {
    switch (name as ToolName) {
      case 'get_token': return this.getToken(String(input.query ?? ''));
      case 'get_price_history': return this.priceHistory(String(input.token ?? ''), clamp(input.period_minutes, 1, 1440), clamp(input.count, 1, 200));
      case 'get_pool_stats': return this.poolStats(String(input.token ?? ''), clamp(input.hours, 1, 168));
      case 'get_flows': return this.flows(String(input.token ?? ''), clamp(input.hours, 1, 168));
      case 'get_holders': return this.holders(String(input.token ?? ''), clamp(input.top, 1, 25));
      case 'get_portfolio': return { source: 'get_portfolio', ...(await this.d.portfolio(userId) as object) };
      default: return { error: `unknown tool ${name}` };
    }
  }

  private async token(q: string): Promise<{ address: Address; symbol: string; decimals: number } | null> {
    const r = isAddress(q, { strict: false })
      ? await this.d.pool.query<{ address: string; symbol: string; decimals: number }>('SELECT address, symbol, decimals FROM tokens WHERE address = $1', [q.toLowerCase()])
      : await this.d.pool.query<{ address: string; symbol: string; decimals: number }>('SELECT address, symbol, decimals FROM tokens WHERE upper(symbol) = upper($1) ORDER BY first_seen_at LIMIT 1', [q]);
    const t = r.rows[0];
    return t ? { address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals } : null;
  }

  private async indexedBlock(stream: string): Promise<string | null> {
    const r = await this.d.pool.query<{ last_block: string }>('SELECT last_block FROM indexer_state WHERE stream = $1', [stream]);
    return r.rows[0]?.last_block ?? null;
  }

  private async getToken(q: string) {
    const all = isAddress(q, { strict: false })
      ? await this.d.pool.query('SELECT address, symbol, name, decimals, is_stock_token FROM tokens WHERE address = $1', [q.toLowerCase()])
      : await this.d.pool.query('SELECT address, symbol, name, decimals, is_stock_token FROM tokens WHERE upper(symbol) = upper($1) LIMIT 5', [q]);
    if (!all.rows.length) {
      // not used by any agent yet: fall back to the chain-wide catalog (every token with a pool)
      const cat = isAddress(q, { strict: false })
        ? await this.d.pool.query('SELECT address, symbol, name, decimals, is_stock_token, tradable, depth_usdg::float AS depth_usdg, pools FROM token_catalog WHERE address = $1 AND error IS NULL', [q.toLowerCase()])
        : await this.d.pool.query('SELECT address, symbol, name, decimals, is_stock_token, tradable, depth_usdg::float AS depth_usdg, pools FROM token_catalog WHERE upper(symbol) = upper($1) AND error IS NULL ORDER BY depth_usdg DESC NULLS LAST LIMIT 5', [q]);
      if (!cat.rows.length) return { source: 'get_token', found: false, note: 'No pool for this token on Robinhood Chain was found.' };
      return {
        source: 'get_token', found: true, registered: false, ambiguous_symbol: cat.rows.length > 1,
        tokens: cat.rows.map((t) => ({ address: getAddress(t.address), symbol: sanitizeSymbol(t.symbol), name: sanitizeName(t.name), decimals: t.decimals, stock_token: t.is_stock_token, tradable_via_usdg_or_weth: t.tradable, base_pool_depth_usdg: t.depth_usdg, pools: t.pools })),
        note: 'From the chain-wide pool catalog; price history and flows exist only once a user adds the token to an agent.',
        as_of: new Date().toISOString(),
      };
    }
    const tokens = [];
    for (const t of all.rows) {
      const routes = await this.d.pool.query('SELECT quote_address, path, pools::text[] AS pools FROM routes WHERE token_address = $1', [t.address]);
      tokens.push({ address: getAddress(t.address), symbol: sanitizeSymbol(t.symbol), name: sanitizeName(t.name), decimals: t.decimals, stock_token: t.is_stock_token, routes: routes.rows });
    }
    return { source: 'get_token', found: true, ambiguous_symbol: tokens.length > 1, tokens, as_of: new Date().toISOString() };
  }

  private async priceHistory(q: string, period: number, count: number) {
    const t = await this.token(q);
    if (!t) return { source: 'get_price_history', error: 'unknown token' };
    if (t.address === this.d.usdg) return { source: 'get_price_history', token: t.address, note: 'USDG is the unit of account (1 USDG).' };
    const r = await this.d.pool.query(
      `SELECT time_bucket(make_interval(mins => $2), ts) AS t, first(price, ts)::float AS o, max(price)::float AS h, min(price)::float AS l, last(price, ts)::float AS c, count(*)::int AS samples
         FROM market_snapshots WHERE token_address = $1 AND ts > now() - make_interval(mins => $2 * $3)
        GROUP BY 1 ORDER BY 1`,
      [t.address.toLowerCase(), period, count],
    );
    return { source: 'get_price_history', token: t.address, symbol: t.symbol, unit: 'USDG per token (pool mid price)', period_minutes: period, candles: r.rows, as_of: r.rows.at(-1)?.t ?? null };
  }

  private async poolStats(q: string, hours: number) {
    const t = await this.token(q);
    if (!t) return { source: 'get_pool_stats', error: 'unknown token' };
    const pools = await this.d.pool.query<{ pool: string }>('SELECT DISTINCT unnest(pools::text[]) AS pool FROM routes WHERE token_address = $1', [t.address.toLowerCase()]);
    const out = [];
    for (const p of pools.rows) {
      const addr = getAddress(p.pool);
      const [liquidity, fee] = await Promise.all([
        this.c.readContract({ address: addr, abi: poolAbi, functionName: 'liquidity' }),
        this.c.readContract({ address: addr, abi: poolAbi, functionName: 'fee' }),
      ]);
      const v = await this.d.pool.query<{ swaps: number; abs0: string | null; abs1: string | null }>(
        `SELECT count(*)::int AS swaps, sum(abs(amount0)) AS abs0, sum(abs(amount1)) AS abs1 FROM swaps WHERE pool = $1 AND block_time > now() - make_interval(hours => $2)`,
        [p.pool, hours],
      );
      out.push({ pool: addr, fee_tier: fee, liquidity: liquidity.toString(), window_hours: hours, swaps: v.rows[0]!.swaps, volume_token0_raw: v.rows[0]!.abs0 ?? '0', volume_token1_raw: v.rows[0]!.abs1 ?? '0', indexed_to_block: await this.indexedBlock(`swap:${p.pool}`) });
    }
    return { source: 'get_pool_stats', token: t.address, symbol: t.symbol, pools: out, note: 'Swap volume covers only the indexed window; liquidity is read live.' };
  }

  private async flows(q: string, hours: number) {
    const t = await this.token(q);
    if (!t) return { source: 'get_flows', error: 'unknown token' };
    const ta = t.address.toLowerCase();
    // per pool, token0 is the lower address; amount > 0 means the pool received it (users sold it)
    const pools = await this.d.pool.query<{ pool: string; quote: string }>('SELECT DISTINCT unnest(pools::text[]) AS pool, quote_address AS quote FROM routes WHERE token_address = $1', [ta]);
    let bought = 0;
    let sold = 0;
    for (const p of pools.rows) {
      const token0 = ((await this.c.readContract({ address: getAddress(p.pool), abi: poolAbi, functionName: 'token0' })) as string).toLowerCase();
      const col = token0 === ta ? 'amount0' : 'amount1';
      const r = await this.d.pool.query<{ into_pool: string | null; out_of_pool: string | null }>(
        `SELECT sum(${col}) FILTER (WHERE ${col} > 0) AS into_pool, -sum(${col}) FILTER (WHERE ${col} < 0) AS out_of_pool FROM swaps WHERE pool = $1 AND block_time > now() - make_interval(hours => $2)`,
        [p.pool, hours],
      );
      sold += Number(r.rows[0]?.into_pool ?? 0) / 10 ** t.decimals;
      bought += Number(r.rows[0]?.out_of_pool ?? 0) / 10 ** t.decimals;
    }
    const large = await this.d.pool.query(
      `SELECT block, block_time, "from", "to", (amount::numeric / 10 ^ $3)::float AS amount FROM transfers
        WHERE token_address = $1 AND block_time > now() - make_interval(hours => $2) ORDER BY amount DESC LIMIT 10`,
      [ta, hours, t.decimals],
    );
    return {
      source: 'get_flows', token: t.address, symbol: t.symbol, window_hours: hours,
      bought_from_pools: bought, sold_into_pools: sold, net_buy: bought - sold, unit: `${t.symbol} (whole tokens)`,
      largest_transfers: large.rows, indexed_to_block: await this.indexedBlock(`transfer:${ta}`),
      note: 'Covers routed pools and the indexed window only.',
    };
  }

  private async holders(q: string, top: number) {
    const t = await this.token(q);
    if (!t) return { source: 'get_holders', error: 'unknown token' };
    const ta = t.address.toLowerCase();
    const cand = await this.d.pool.query<{ addr: string }>(
      `SELECT addr FROM (SELECT "to" AS addr, sum(amount) AS v FROM transfers WHERE token_address = $1 GROUP BY 1) x ORDER BY v DESC LIMIT 60`,
      [ta],
    );
    const supply = await this.c.readContract({ address: t.address, abi: erc20, functionName: 'totalSupply' });
    const head = await this.c.getBlockNumber();
    const bals = await Promise.all(cand.rows.map(async (r) => ({ address: getAddress(r.addr), balance: await this.c.readContract({ address: t.address, abi: erc20, functionName: 'balanceOf', args: [getAddress(r.addr)], blockNumber: head }) })));
    const rows = bals.filter((b) => b.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : -1)).slice(0, top);
    return {
      source: 'get_holders', token: t.address, symbol: t.symbol, as_of_block: head.toString(), total_supply: (Number(supply) / 10 ** t.decimals),
      holders: rows.map((r) => ({ address: r.address, balance: Number(r.balance) / 10 ** t.decimals, share_pct: supply > 0n ? (Number(r.balance) / Number(supply)) * 100 : null })),
      coverage: `candidates are addresses that received the token since indexed block ${await this.indexedBlock(`transfer:${ta}`) ?? 'n/a'}; balances are live`,
    };
  }
}
