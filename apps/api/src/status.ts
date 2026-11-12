import type { Pool } from '@odin/db';
import { HEALTH_URLS } from '@odin/shared';

/** Public names for the services; internal ports, commits and error texts are never published. */
const LABELS: Record<string, string> = {
  web: 'Web app',
  api: 'API',
  signer: 'Transaction signer',
  guard: 'Take-profit / stop-loss guard',
  runtime: 'AI trading agents',
  market: 'Market data',
  indexer: 'Chain indexer',
  signals: 'Signals & alerts',
  notifier: 'Notifications',
  watchdog: 'Monitoring',
  backtest: 'Backtests',
};

export type PublicStatus = {
  overall: 'operational' | 'degraded';
  services: { name: string; status: 'up' | 'down' }[];
  data: { pricesAgeSeconds: number | null; indexerAgeSeconds: number | null };
  generatedAt: string;
};

/**
 * Public status (architecture §10): which services are up and how fresh market data is. Probes the loopback
 * /healthz endpoints of the services expected on this host (WATCHDOG_SERVICES), cached for 15 s so the
 * public endpoint cannot be used to hammer them.
 */
export class StatusService {
  private readonly pool: Pool;
  private readonly expected: string[];
  private cache: { at: number; value: Promise<PublicStatus> } | null = null;

  constructor(pool: Pool, expected = (process.env.WATCHDOG_SERVICES ?? 'signer,api,web,market,guard,notifier,indexer,signals').split(',')) {
    this.pool = pool;
    this.expected = expected.map((s) => s.trim()).filter((s) => HEALTH_URLS[s]);
  }

  get(): Promise<PublicStatus> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.value;
    const value = this.compute();
    this.cache = { at: Date.now(), value };
    value.catch(() => (this.cache = null));
    return value;
  }

  private async compute(): Promise<PublicStatus> {
    const services = await Promise.all(
      this.expected.map(async (s) => {
        let up = false;
        if (s === 'api') up = true; // answering this request
        else {
          try {
            up = (await fetch(HEALTH_URLS[s]!, { signal: AbortSignal.timeout(2_000) })).ok;
          } catch {
            up = false;
          }
        }
        return { name: LABELS[s] ?? s, status: up ? ('up' as const) : ('down' as const) };
      }),
    );
    const d = await this.pool.query<{ prices: number | null; indexer: number | null }>(
      `SELECT extract(epoch FROM now() - (SELECT max(ts) FROM market_snapshots))::int AS prices,
              extract(epoch FROM now() - (SELECT max(updated_at) FROM indexer_state WHERE stream NOT LIKE 'pools:%'))::int AS indexer`,
    );
    return {
      overall: services.every((s) => s.status === 'up') ? 'operational' : 'degraded',
      services,
      data: { pricesAgeSeconds: d.rows[0]?.prices ?? null, indexerAgeSeconds: d.rows[0]?.indexer ?? null },
      generatedAt: new Date().toISOString(),
    };
  }
}

export type PublicPrice = { symbol: string; address: string; price: number; changePct: number | null; asOf: string };

/**
 * Public price tape (landing page ticker): the latest USDG price of every registered token from the minute
 * snapshots, with its change over ~24 h when recorded. Only fresh prices (< 1 h) are published; cached 30 s.
 * Symbols come from the registry, already sanitized; the web app renders them as text.
 */
export class PublicPrices {
  private readonly pool: Pool;
  private cache: { at: number; value: Promise<PublicPrice[]> } | null = null;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  get(): Promise<PublicPrice[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const value = this.pool
      .query<{ symbol: string; address: string; price: string; prev: string | null; ts: Date }>(
        `SELECT t.symbol, t.address, s.price, s.ts,
                (SELECT p.price FROM market_snapshots p WHERE p.token_address = t.address AND p.ts <= now() - interval '24 hours'
                  ORDER BY p.ts DESC LIMIT 1) AS prev
           FROM tokens t
           JOIN LATERAL (SELECT price, ts FROM market_snapshots WHERE token_address = t.address ORDER BY ts DESC LIMIT 1) s ON true
          WHERE s.ts > now() - interval '1 hour' AND t.symbol <> ''
          ORDER BY t.is_stock_token DESC, t.symbol
          LIMIT 40`,
      )
      .then((r) =>
        r.rows.map((x) => {
          const price = Number(x.price);
          const prev = x.prev === null ? null : Number(x.prev);
          return { symbol: x.symbol, address: x.address, price, changePct: prev && prev > 0 ? ((price - prev) / prev) * 100 : null, asOf: x.ts.toISOString() };
        }),
      );
    this.cache = { at: Date.now(), value };
    value.catch(() => (this.cache = null));
    return value;
  }
}
