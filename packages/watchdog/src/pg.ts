import { createPublicClient, fallback, getAddress, http, type Address } from 'viem';
import type { Pool } from '@odin/db';
import { FallbackChain, PgExecutionStore, checkNonce, reconcileInflight } from '@odin/executor';
import type { AlertSink, WatchdogData } from './watchdog.ts';

export class PgWatchdogData implements WatchdogData {
  private readonly pool: Pool;
  private readonly chain: FallbackChain;
  private readonly store: PgExecutionStore;
  private readonly c;

  constructor(pool: Pool, rpcUrls: string[]) {
    this.pool = pool;
    this.chain = new FallbackChain(rpcUrls);
    this.store = new PgExecutionStore(pool);
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 10_000 }))) });
  }

  async liveAgents() {
    const r = await this.pool.query<{ id: string; user_id: string; address: string }>(
      `SELECT a.id, a.user_id, w.address FROM agents a JOIN agent_wallets w ON w.agent_id = a.id
        WHERE a.status IN ('active', 'paused')
          AND (a.mode = 'live' OR EXISTS (SELECT 1 FROM positions p WHERE p.agent_id = a.id AND p.mode = 'live' AND p.qty > 0))`,
    );
    return r.rows.map((x) => ({ agentId: x.id, userId: x.user_id, wallet: getAddress(x.address) }));
  }

  nativeBalance(wallet: Address) {
    return this.c.getBalance({ address: wallet });
  }

  async nonceDrift() {
    const r = await this.pool.query<{ wallet: string; agent_id: string }>(
      `SELECT DISTINCT e.wallet, w.agent_id FROM executions e JOIN agent_wallets w ON w.address = e.wallet`,
    );
    const out = [];
    for (const x of r.rows) out.push({ agentId: x.agent_id, ...(await checkNonce(this.chain, this.store, getAddress(x.wallet))) });
    return out;
  }

  reconcile() {
    return reconcileInflight(this.chain, this.store, { olderThanMs: 5 * 60_000 });
  }

  async overdueAgents(seconds: number) {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_schedule s JOIN agents a ON a.id = s.agent_id
        WHERE a.status = 'active' AND s.next_tick_at < now() - make_interval(secs => $1)
          AND (s.lease_until IS NULL OR s.lease_until < now())`,
      [seconds],
    );
    return r.rows[0]?.n ?? 0;
  }

  async llmOutcomes(minutes: number) {
    const r = await this.pool.query<{ total: number; failed: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM rejections x WHERE x.decision_id = d.id AND x.code IN ('llm_unavailable', 'llm_invalid_output', 'llm_refused')))::int AS failed
         FROM decisions d WHERE d.origin = 'agent' AND d.created_at > now() - make_interval(mins => $1)`,
      [minutes],
    );
    return r.rows[0] ?? { total: 0, failed: 0 };
  }

  async indexerLag() {
    const r = await this.pool.query<{ b: string | null }>(`SELECT min(last_block) AS b FROM indexer_state WHERE contract IS NOT NULL`);
    if (!r.rows[0]?.b) return null;
    return (await this.c.getBlockNumber()) - BigInt(r.rows[0].b);
  }

  async snapshotAge() {
    const r = await this.pool.query<{ s: number | null }>(`SELECT extract(epoch FROM now() - max(ts))::int AS s FROM market_snapshots`);
    return r.rows[0]?.s ?? null;
  }
}

export class PgAlertSink implements AlertSink {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async claim(key: string, cooldownSeconds: number, detail: unknown) {
    const r = await this.pool.query(
      `INSERT INTO watchdog_state (key, last_alert_at, detail) VALUES ($1, now(), $3)
       ON CONFLICT (key) DO UPDATE SET last_alert_at = now(), detail = EXCLUDED.detail
         WHERE watchdog_state.last_alert_at < now() - make_interval(secs => $2)`,
      [key, cooldownSeconds, JSON.stringify(detail)],
    );
    return r.rowCount === 1;
  }

  async emit(a: { userId: string | null; sourceId: string; payload: Record<string, unknown> }) {
    await this.pool.query(`INSERT INTO alert_events (source, source_id, user_id, payload) VALUES ('system', $1, $2, $3)`, [a.sourceId, a.userId, JSON.stringify(a.payload)]);
  }
}
