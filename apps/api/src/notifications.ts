import { z } from 'zod';
import type { Pool } from '@odin/db';
import { Rejection } from '@odin/shared';

export const ChannelsInput = z
  .object({
    /** Telegram chat id (numeric, or @channelname); null removes the channel. */
    telegram: z.object({ chatId: z.string().regex(/^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/), enabled: z.boolean().default(true) }).strict().nullable().optional(),
  })
  .strict();

export class NotificationService {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** In-app feed (architecture §3.11): every alert for the user, newest first. */
  async feed(userId: string, limit: number) {
    const r = await this.pool.query(
      `SELECT id, source, payload, delivered_channels, last_error, created_at FROM alert_events
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return r.rows;
  }

  async channels(userId: string) {
    const r = await this.pool.query<{ kind: string; target: string; enabled: boolean }>('SELECT kind, target, enabled FROM notification_channels WHERE user_id = $1', [userId]);
    return { in_app: { enabled: true }, ...Object.fromEntries(r.rows.map((c) => [c.kind, { chatId: c.target, enabled: c.enabled }])) };
  }

  async setChannels(userId: string, input: z.infer<typeof ChannelsInput>) {
    if (input.telegram === null) await this.pool.query(`DELETE FROM notification_channels WHERE user_id = $1 AND kind = 'telegram'`, [userId]);
    else if (input.telegram) {
      await this.pool.query(
        `INSERT INTO notification_channels (user_id, kind, target, enabled) VALUES ($1, 'telegram', $2, $3)
         ON CONFLICT (user_id, kind) DO UPDATE SET target = EXCLUDED.target, enabled = EXCLUDED.enabled`,
        [userId, input.telegram.chatId, input.telegram.enabled],
      );
    }
    return this.channels(userId);
  }

  async test(userId: string) {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO alert_events (source, source_id, user_id, payload) VALUES ('system', $1, $1, '{"event":"test"}') RETURNING id`,
      [userId],
    );
    if (!r.rows[0]) throw new Rejection('internal_error', 'could not queue');
    return { id: r.rows[0].id };
  }
}
