import { getAddress, type Address, type Hex } from 'viem';
import { decodePath, type FeeTier } from '@odin/shared';
import type { Pool } from '@odin/db';

export type TokenRow = { address: Address; decimals: number; symbol: string; name: string; isStockToken: boolean };
export type StoredRoute = { token: Address; quote: Address; path: Hex; pools: Address[]; fees: FeeTier[]; tokens: Address[] };
export type SnapshotRow = { ts: Date; token: Address; pool: Address; feeTier: number; price: number; oraclePrice: number | null };

export interface MarketStore {
  upsertToken(t: TokenRow): Promise<void>;
  getToken(address: Address): Promise<TokenRow | null>;
  listTokens(): Promise<TokenRow[]>;
  replaceRoutes(token: Address, routes: { quote: Address; path: Hex; pools: Address[] }[]): Promise<void>;
  routes(): Promise<StoredRoute[]>;
  insertSnapshots(rows: SnapshotRow[]): Promise<void>;
}

const lc = (a: string) => a.toLowerCase();

export class PgMarketStore implements MarketStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async upsertToken(t: TokenRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO tokens (address, decimals, symbol, name, is_stock_token) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, is_stock_token = EXCLUDED.is_stock_token`,
      [lc(t.address), t.decimals, t.symbol, t.name, t.isStockToken],
    );
  }

  async getToken(address: Address): Promise<TokenRow | null> {
    const r = await this.pool.query<{ address: string; decimals: number; symbol: string; name: string; is_stock_token: boolean }>(
      'SELECT address, decimals, symbol, name, is_stock_token FROM tokens WHERE address = $1',
      [lc(address)],
    );
    const x = r.rows[0];
    return x ? { address: getAddress(x.address), decimals: x.decimals, symbol: x.symbol, name: x.name, isStockToken: x.is_stock_token } : null;
  }

  async listTokens(): Promise<TokenRow[]> {
    const r = await this.pool.query<{ address: string; decimals: number; symbol: string; name: string; is_stock_token: boolean }>(
      'SELECT address, decimals, symbol, name, is_stock_token FROM tokens ORDER BY address',
    );
    return r.rows.map((x) => ({ address: getAddress(x.address), decimals: x.decimals, symbol: x.symbol, name: x.name, isStockToken: x.is_stock_token }));
  }

  async replaceRoutes(token: Address, routes: { quote: Address; path: Hex; pools: Address[] }[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM routes WHERE token_address = $1', [lc(token)]);
      for (const r of routes) {
        await client.query('INSERT INTO routes (token_address, quote_address, path, pools) VALUES ($1, $2, $3, $4)', [
          lc(token),
          lc(r.quote),
          r.path.toLowerCase(),
          r.pools.map(lc),
        ]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async routes(): Promise<StoredRoute[]> {
    const r = await this.pool.query<{ token_address: string; quote_address: string; path: Hex; pools: string[] }>(
      // pg does not parse arrays of a domain type; cast so `pools` arrives as a JS array
      'SELECT token_address, quote_address, path, pools::text[] AS pools FROM routes',
    );
    return r.rows.map((x) => {
      const d = decodePath(x.path);
      return { token: getAddress(x.token_address), quote: getAddress(x.quote_address), path: x.path, pools: x.pools.map((p) => getAddress(p)), fees: d.fees, tokens: d.tokens };
    });
  }

  async insertSnapshots(rows: SnapshotRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values: unknown[] = [];
    const tuples = rows.map((s, i) => {
      values.push(s.ts, lc(s.token), lc(s.pool), s.feeTier, s.price, s.oraclePrice);
      const o = i * 6;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    await this.pool.query(`INSERT INTO market_snapshots (ts, token_address, pool, fee_tier, price, oracle_price) VALUES ${tuples.join(', ')}`, values);
  }
}

export class MemoryMarketStore implements MarketStore {
  tokens = new Map<string, TokenRow>();
  routeRows = new Map<string, { token: Address; quote: Address; path: Hex; pools: Address[] }>();
  snapshots: SnapshotRow[] = [];

  async upsertToken(t: TokenRow) {
    this.tokens.set(lc(t.address), t);
  }
  async getToken(a: Address) {
    return this.tokens.get(lc(a)) ?? null;
  }
  async listTokens() {
    return [...this.tokens.values()];
  }
  async replaceRoutes(token: Address, routes: { quote: Address; path: Hex; pools: Address[] }[]) {
    for (const k of [...this.routeRows.keys()]) if (k.startsWith(lc(token))) this.routeRows.delete(k);
    for (const r of routes) this.routeRows.set(`${lc(token)}:${lc(r.quote)}`, { token, ...r, path: r.path.toLowerCase() as Hex });
  }
  async routes() {
    return [...this.routeRows.values()].map((r) => {
      const d = decodePath(r.path);
      return { ...r, fees: d.fees, tokens: d.tokens };
    });
  }
  async insertSnapshots(rows: SnapshotRow[]) {
    this.snapshots.push(...rows);
  }
}
