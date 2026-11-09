import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPool, type Pool } from '@odin/db';
import { formatAlert, Notifier, PgNotifyStore, type Channel, type NotifyStore, type PendingAlert, type Sender } from '../src/index.ts';

class MemStore implements NotifyStore {
  alerts: (PendingAlert & { delivered?: string[]; error?: string | null; nextAt?: number })[] = [];
  chans = new Map<string, Channel[]>();
  async claim() {
    return this.alerts.filter((a) => !a.delivered);
  }
  async channels(userId: string) {
    return this.chans.get(userId) ?? [];
  }
  async delivered(id: string, channels: string[], err: string | null) {
    Object.assign(this.alerts.find((a) => a.id === id)!, { delivered: channels, error: err });
  }
  async failed(id: string, error: string, attempts: number) {
    Object.assign(this.alerts.find((a) => a.id === id)!, { attempts, error });
  }
}

class FakeTelegram implements Sender {
  readonly kind = 'telegram' as const;
  sent: { target: string; text: string }[] = [];
  fail = false;
  async send(target: string, text: string) {
    if (this.fail) throw new Error('telegram 502');
    this.sent.push({ target, text });
  }
}

describe('Notifier', () => {
  it('delivers in-app always and to enabled external channels', async () => {
    const store = new MemStore();
    const tg = new FakeTelegram();
    store.alerts.push({ id: 'a', userId: 'u', source: 'guard', attempts: 0, payload: { event: 'guard_fired', type: 'stop_loss', token: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', price: 1990.5, trigger: 2000, mode: 'live' } });
    store.chans.set('u', [{ kind: 'telegram', target: '123' }]);
    expect(await new Notifier(store, [tg]).deliverOnce()).toEqual({ delivered: 1, failed: 0 });
    expect(store.alerts[0]!.delivered).toEqual(['in_app', 'telegram']);
    expect(tg.sent[0]).toEqual({ target: '123', text: 'Stop loss executed: sold 0x0bd7…ad73 at 1990.5000 (trigger 2000.0000).' });
  });

  it('retries a failing channel with backoff, and records unconfigured channels without retrying', async () => {
    const store = new MemStore();
    const tg = new FakeTelegram();
    tg.fail = true;
    store.alerts.push({ id: 'a', userId: 'u', source: 'runtime', attempts: 0, payload: { event: 'test' } });
    store.chans.set('u', [{ kind: 'telegram', target: '1' }]);
    expect(await new Notifier(store, [tg]).deliverOnce()).toEqual({ delivered: 0, failed: 1 });
    expect(store.alerts[0]).toMatchObject({ attempts: 1, error: 'telegram: telegram 502' });

    const s2 = new MemStore();
    s2.alerts.push({ id: 'b', userId: 'u', source: 'runtime', attempts: 0, payload: { event: 'test' } });
    s2.chans.set('u', [{ kind: 'telegram', target: '1' }]);
    await new Notifier(s2, []).deliverOnce();
    expect(s2.alerts[0]).toMatchObject({ delivered: ['in_app'], error: 'telegram: not configured on this server' });
  });

  it('honours a per-alert channel override (in-app always)', async () => {
    const store = new MemStore();
    const tg = new FakeTelegram();
    store.alerts.push({ id: 'a', userId: 'u', source: 'rule', attempts: 0, payload: { event: 'test', channels: [] } });
    store.chans.set('u', [{ kind: 'telegram', target: '1' }]);
    await new Notifier(store, [tg]).deliverOnce();
    expect(tg.sent).toHaveLength(0);
    expect(store.alerts[0]!.delivered).toEqual(['in_app']);
  });

  it('formats rule alerts and AI signals', () => {
    expect(formatAlert('rule', { event: 'rule_alert', condition: 'price_below', spec: { token: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', price: 2000 }, detail: { price: 1999.5 } })).toBe('Alert: 0x0bd7…ad73 price 1999.5000 is at or below 2000.');
    expect(formatAlert('signal', { event: 'ai_signal', token: 'X', direction: 'bullish', confidence: 0.72, rationale: 'momentum' })).toBe('AI signal: X bullish (confidence 72%). momentum');
  });

  it('formats failures and close-all results; on-chain text cannot inject control characters', () => {
    expect(formatAlert('guard', { event: 'guard_exit_failed', type: 'take_profit', token: 'X', code: 'price_deviation', message: 'pool off‮ referee\n', attempt: 3 })).toBe(
      'Take profit for X could not execute (price_deviation): pool off referee. It stays armed and will retry (attempt 3).',
    );
    expect(formatAlert('guard', { event: 'close_all', mode: 'paper', tokens: [{ token: 'A', ok: true }, { token: 'B', ok: false, code: 'price_deviation' }] })).toBe(
      'Close all positions [paper]: 1/2 closed; not closed: B (price_deviation). You can retry.',
    );
  });
});

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('notifications (postgres)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(url!, { max: 3 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('resolves the owner from payload.agentId, claims once, and records delivery', async () => {
    const u = await pool.query<{ id: string }>('INSERT INTO users (wallet_address) VALUES ($1) RETURNING id', [`0x${randomBytes(20).toString('hex')}`]);
    const a = await pool.query<{ id: string }>("INSERT INTO agents (user_id, name) VALUES ($1, 'n') RETURNING id", [u.rows[0]!.id]);
    const e = await pool.query<{ id: string; user_id: string }>(
      `INSERT INTO alert_events (source, source_id, payload) VALUES ('runtime', $1, $2) RETURNING id, user_id`,
      [a.rows[0]!.id, JSON.stringify({ event: 'test', agentId: a.rows[0]!.id })],
    );
    expect(e.rows[0]!.user_id).toBe(u.rows[0]!.id);
    const store = new PgNotifyStore(pool);
    const [c1, c2] = await Promise.all([store.claim(500), store.claim(500)]);
    const mine = [...c1!, ...c2!].filter((x) => x.id === e.rows[0]!.id);
    expect(mine).toHaveLength(1);
    await store.delivered(e.rows[0]!.id, ['in_app'], null);
    const d = await pool.query('SELECT delivered_channels, delivered_at FROM alert_events WHERE id = $1', [e.rows[0]!.id]);
    expect(d.rows[0].delivered_channels).toEqual(['in_app']);
    expect(d.rows[0].delivered_at).not.toBeNull();
  });
});
