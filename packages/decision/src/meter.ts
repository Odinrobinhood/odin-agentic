import type { Pool } from '@odin/db';
import type { TokenMeter } from './engine.ts';

/**
 * Per-user daily meter with a platform-wide ceiling: once all users together reach `globalDailyTokens`
 * (env LLM_GLOBAL_DAILY_TOKENS, default 20M), every user reads as exhausted until the UTC day ends, so
 * many free accounts cannot add up to unbounded spend. Guards never call the LLM and are unaffected.
 */
export class PgTokenMeter implements TokenMeter {
  private readonly pool: Pool;
  private readonly globalDailyTokens: number;
  constructor(pool: Pool, globalDailyTokens = Number(process.env.LLM_GLOBAL_DAILY_TOKENS ?? 20_000_000)) {
    this.pool = pool;
    this.globalDailyTokens = globalDailyTokens;
  }

  async usedToday(userId: string, day: string): Promise<number> {
    const r = await this.pool.query<{ mine: string | null; all: string | null }>(
      'SELECT sum(tokens) FILTER (WHERE user_id = $1) AS mine, sum(tokens) AS all FROM llm_usage WHERE day = $2',
      [userId, day],
    );
    if (Number(r.rows[0]?.all ?? 0) >= this.globalDailyTokens) return Number.MAX_SAFE_INTEGER;
    return Number(r.rows[0]?.mine ?? 0);
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
