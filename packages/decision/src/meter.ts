import type { Pool } from '@odin/db';
import type { TokenMeter } from './engine.ts';

export class PgTokenMeter implements TokenMeter {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async usedToday(userId: string, day: string): Promise<number> {
    const r = await this.pool.query<{ n: string | null }>('SELECT sum(tokens) AS n FROM llm_usage WHERE user_id = $1 AND day = $2', [userId, day]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async add(userId: string, source: 'agent' | 'analyst' | 'signal', sourceId: string, day: string, tokens: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_usage (user_id, source, source_id, day, tokens) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, source, source_id, day) DO UPDATE SET tokens = llm_usage.tokens + EXCLUDED.tokens`,
      [userId, source, sourceId, day, tokens],
    );
  }
}

export class MemoryTokenMeter implements TokenMeter {
  rows: { userId: string; day: string; tokens: number }[] = [];
  async usedToday(userId: string, day: string) {
    return this.rows.filter((r) => r.userId === userId && r.day === day).reduce((s, r) => s + r.tokens, 0);
  }
  async add(userId: string, _s: string, _id: string, day: string, tokens: number) {
    this.rows.push({ userId, day, tokens });
  }
}
