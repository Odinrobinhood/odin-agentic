import type { Pool } from '@odin/db';
import { Rejection } from '@odin/shared';

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

  async test(userId: string) {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO alert_events (source, source_id, user_id, payload) VALUES ('system', $1, $1, '{"event":"test"}') RETURNING id`,
      [userId],
    );
    if (!r.rows[0]) throw new Rejection('internal_error', 'could not queue');
    return { id: r.rows[0].id };
  }
}
