import type { Pool } from '@odin/db';
import { formatAlert } from './format.ts';

export type PendingAlert = { id: string; userId: string | null; source: string; payload: Record<string, unknown>; attempts: number };
export type Channel = { kind: 'telegram'; target: string };

export interface Sender {
  readonly kind: Channel['kind'];
  send(target: string, text: string): Promise<void>;
}

export interface NotifyStore {
  /** Undelivered alerts whose next attempt is due; rows another notifier holds are skipped. */
  claim(limit: number): Promise<PendingAlert[]>;
  channels(userId: string): Promise<Channel[]>;
  delivered(id: string, channels: string[], partialError: string | null): Promise<void>;
  /** Exponential backoff; gives up (marks delivered with the error) after `maxAttempts`. */
  failed(id: string, error: string, attempts: number, maxAttempts: number): Promise<void>;
}

export const MAX_ATTEMPTS = 6;

/**
 * Notifier (architecture §3.11): every alert is visible in-app (the feed reads alert_events); external
 * channels are delivered here. A channel failing is retried with backoff and never blocks other channels.
 */
export class Notifier {
  private readonly store: NotifyStore;
  private readonly senders: Map<string, Sender>;
  private readonly operator: Channel | null;

  /** `operator`: where operator alerts (payload.operator = true, no user) go, e.g. the ops Telegram chat. */
  constructor(store: NotifyStore, senders: Sender[], opts: { operator?: Channel } = {}) {
    this.store = store;
    this.senders = new Map(senders.map((s) => [s.kind, s]));
    this.operator = opts.operator ?? null;
  }

  async deliverOnce(limit = 50): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const a of await this.store.claim(limit)) {
      const done = ['in_app'];
      const errors: string[] = [];
      const isOperator = !a.userId && a.payload.operator === true;
      if (a.userId || isOperator) {
        const text = formatAlert(a.source, a.payload);
        // per-alert channel override (architecture §3.11): in-app always, external only if listed
        const only = Array.isArray(a.payload.channels) ? new Set((a.payload.channels as unknown[]).map(String)) : null;
        const targets = isOperator ? (this.operator ? [this.operator] : []) : (await this.store.channels(a.userId!)).filter((c) => !only || only.has(c.kind));
        if (isOperator) done[0] = 'operator_log';
        for (const ch of targets) {
          const sender = this.senders.get(ch.kind);
          if (!sender) {
            errors.push(`${ch.kind}: not configured on this server`);
            continue;
          }
          try {
            await sender.send(ch.target, text);
            done.push(ch.kind);
          } catch (e) {
            errors.push(`${ch.kind}: ${(e as Error).message.slice(0, 200)}`);
          }
        }
      }
      const retryable = errors.filter((e) => !e.endsWith('not configured on this server'));
      if (retryable.length > 0 && a.attempts + 1 < MAX_ATTEMPTS && done.length === 1) {
        await this.store.failed(a.id, retryable.join('; '), a.attempts + 1, MAX_ATTEMPTS);
        failed++;
      } else {
        await this.store.delivered(a.id, done, errors.length ? errors.join('; ') : null);
        delivered++;
      }
    }
    return { delivered, failed };
  }
}

export class PgNotifyStore implements NotifyStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async claim(limit: number): Promise<PendingAlert[]> {
    // lease by pushing next_attempt_at forward; a crashed notifier's rows come back after the lease
    const r = await this.pool.query<{ id: string; user_id: string | null; source: string; payload: Record<string, unknown>; attempts: number }>(
      `UPDATE alert_events SET next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (SELECT id FROM alert_events WHERE delivered_at IS NULL AND next_attempt_at <= now()
                      ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, user_id, source, payload, attempts`,
      [limit],
    );
    return r.rows.map((x) => ({ id: x.id, userId: x.user_id, source: x.source, payload: x.payload, attempts: x.attempts }));
  }

  async channels(userId: string): Promise<Channel[]> {
    const r = await this.pool.query<{ kind: 'telegram'; target: string }>('SELECT kind, target FROM notification_channels WHERE user_id = $1 AND enabled', [userId]);
    return r.rows;
  }

  async delivered(id: string, channels: string[], partialError: string | null): Promise<void> {
    await this.pool.query('UPDATE alert_events SET delivered_at = now(), delivered_channels = $2, last_error = $3 WHERE id = $1', [id, channels, partialError]);
  }

  async failed(id: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
    const backoffSeconds = Math.min(3600, 15 * 2 ** attempts);
    await this.pool.query(
      `UPDATE alert_events SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4),
              delivered_at = CASE WHEN $2 >= $5 THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, attempts, error, backoffSeconds, maxAttempts],
    );
  }
}

/** Telegram Bot API (plain text, no parse mode). Enabled when TELEGRAM_BOT_TOKEN is set. */
export class TelegramSender implements Sender {
  readonly kind = 'telegram' as const;
  private readonly token: string;
  constructor(token: string) {
    this.token = token;
  }
  async send(chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  }
}
