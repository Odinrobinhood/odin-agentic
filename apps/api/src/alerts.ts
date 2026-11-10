import { z } from 'zod';
import type { Pool } from '@odin/db';
import { RuleSpec } from '@odin/signals';
import { Rejection } from '@odin/shared';
import { SUPPORTED_MODELS } from './agents.ts';

// in-app only (no external channels): the feed always shows every alert
const channels = z.array(z.never()).max(0).default([]);
export const AlertInput = z.object({ rule: RuleSpec, channels, cooldownSeconds: z.number().int().min(60).max(7 * 86_400).default(3600), enabled: z.boolean().default(true) }).strict();
export const AlertPatch = z.object({ channels: z.array(z.never()).max(0).optional(), cooldownSeconds: z.number().int().min(60).max(7 * 86_400).optional(), enabled: z.boolean().optional() }).strict();
export const ProfileInput = z
  .object({
    mandate: z.string().max(20_000),
    model: z.enum(SUPPORTED_MODELS),
    tokens: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(20),
    cadenceSeconds: z.number().int().min(300).max(7 * 86_400),
    channels,
    enabled: z.boolean().default(true),
  })
  .strict();

const uuid = (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Rejection('bad_request', 'bad id');
  return id;
};

/** Rule alerts and AI signal profiles (architecture §3.14). Information only: nothing here can trade. */
export class AlertService {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async list(userId: string) {
    return (await this.pool.query('SELECT id, condition, params, channels, cooldown_seconds, enabled, last_fired_at, created_at FROM rule_alerts WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  }

  async create(userId: string, a: z.infer<typeof AlertInput>) {
    const n = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM rule_alerts WHERE user_id = $1', [userId]);
    if (n.rows[0]!.n >= 100) throw new Rejection('bad_request', 'alert limit reached (100)');
    const { condition, ...params } = a.rule;
    const target = 'token' in params ? { kind: 'token', address: params.token } : 'pool' in params ? { kind: 'pool', address: params.pool } : { kind: 'wallet', address: (params as { address: string }).address };
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO rule_alerts (user_id, target, condition, params, channels, cooldown_seconds, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, JSON.stringify(target), condition, JSON.stringify(params), a.channels, a.cooldownSeconds, a.enabled],
    );
    return { id: r.rows[0]!.id };
  }

  async patch(userId: string, id: string, p: z.infer<typeof AlertPatch>) {
    const r = await this.pool.query(
      `UPDATE rule_alerts SET channels = COALESCE($3, channels), cooldown_seconds = COALESCE($4, cooldown_seconds), enabled = COALESCE($5, enabled) WHERE id = $1 AND user_id = $2`,
      [uuid(id), userId, p.channels ?? null, p.cooldownSeconds ?? null, p.enabled ?? null],
    );
    if (!r.rowCount) throw new Rejection('bad_request', 'unknown alert');
  }

  async remove(userId: string, id: string) {
    await this.pool.query('DELETE FROM rule_alerts WHERE id = $1 AND user_id = $2', [uuid(id), userId]);
  }

  async profiles(userId: string) {
    return (
      await this.pool.query(
        `SELECT DISTINCT ON (p.id) p.id, p.version, p.system_prompt AS mandate, p.model_name AS model, p.tokens, p.cadence_seconds, p.channels, p.enabled, s.next_run_at, s.last_run_at, s.last_error
           FROM signal_profiles p LEFT JOIN signal_schedule s ON s.profile_id = p.id WHERE p.user_id = $1 ORDER BY p.id, p.version DESC`,
        [userId],
      )
    ).rows;
  }

  /** Create a profile, or (with `id`) add a new version of an existing one. */
  async saveProfile(userId: string, p: z.infer<typeof ProfileInput>, id?: string) {
    const tokens = p.tokens.map((t) => t.toLowerCase());
    const known = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tokens WHERE address = ANY($1)', [tokens]);
    if (known.rows[0]!.n !== new Set(tokens).size) throw new Rejection('token_not_allowed', 'every watched token must be in the token registry (add it as an agent asset first)');
    if (id) {
      const own = await this.pool.query('SELECT 1 FROM signal_profiles WHERE id = $1 AND user_id = $2 LIMIT 1', [uuid(id), userId]);
      if (!own.rowCount) throw new Rejection('bad_request', 'unknown profile');
    } else {
      // each profile runs the model on its own schedule: bound how many one user can create
      const n = await this.pool.query<{ n: number }>('SELECT count(DISTINCT id)::int AS n FROM signal_profiles WHERE user_id = $1', [userId]);
      if (n.rows[0]!.n >= 20) throw new Rejection('bad_request', 'at most 20 AI signal profiles per user');
    }
    const r = await this.pool.query<{ id: string; version: number }>(
      `INSERT INTO signal_profiles (id, user_id, version, system_prompt, model_provider, model_name, tokens, cadence_seconds, channels, enabled)
       VALUES (COALESCE($1, gen_random_uuid()), $2, COALESCE((SELECT max(version) FROM signal_profiles WHERE id = $1), 0) + 1, $3, 'anthropic', $4, $5, $6, $7, $8)
       RETURNING id, version`,
      [id ?? null, userId, p.mandate, p.model, tokens, p.cadenceSeconds, p.channels, p.enabled],
    );
    if (id) await this.pool.query('UPDATE signal_schedule SET next_run_at = now() WHERE profile_id = $1', [id]);
    return r.rows[0]!;
  }

  async signals(userId: string, limit: number) {
    return (
      await this.pool.query(
        `SELECT s.id, s.profile_id, s.token_address, s.direction, s.rationale, s.thesis, s.confidence, s.model, s.created_at
           FROM signals s WHERE s.profile_id IN (SELECT DISTINCT id FROM signal_profiles WHERE user_id = $1) ORDER BY s.created_at DESC LIMIT $2`,
        [userId, Math.min(Math.max(limit, 1), 200)],
      )
    ).rows;
  }
}
