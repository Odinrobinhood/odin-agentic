import type { Pool } from '@odin/db';
import { TriggerSpec, evaluate, type RuleData } from '@odin/signals';

export type TriggerAgent = { agentId: string; configVersion: number; triggers: unknown[] };
export type TriggerState = { idx: number; configVersion: number; holding: boolean; lastFiredAt: Date | null };

export interface TriggerStore {
  /** Active agents whose latest config has at least one trigger. */
  agents(): Promise<TriggerAgent[]>;
  states(agentId: string): Promise<TriggerState[]>;
  saveState(agentId: string, s: TriggerState): Promise<void>;
  /** Pull the agent's next tick to now with a reason, unless a worker is ticking it right now. */
  wake(agentId: string, reason: Record<string, unknown>): Promise<boolean>;
}

/** No trigger fires more often than the cadence floor. */
export const TRIGGER_MIN_INTERVAL_MS = 60_000;

/**
 * Price triggers (architecture §3.5). Edge-triggered: a trigger fires when its condition starts to hold and
 * re-arms only after the condition is false again, so a lasting condition wakes the agent once, not on
 * every pass. A trigger only pulls the next tick forward; the tick itself goes through the normal flow.
 */
export class TriggerWatcher {
  private readonly store: TriggerStore;
  private readonly data: RuleData;
  private readonly now: () => Date;

  constructor(deps: { store: TriggerStore; data: RuleData; now?: () => Date }) {
    this.store = deps.store;
    this.data = deps.data;
    this.now = deps.now ?? (() => new Date());
  }

  async checkOnce(): Promise<{ agentId: string; idx: number; woke: boolean }[]> {
    const fired: { agentId: string; idx: number; woke: boolean }[] = [];
    for (const a of await this.store.agents()) {
      const states = new Map((await this.store.states(a.agentId)).filter((s) => s.configVersion === a.configVersion).map((s) => [s.idx, s]));
      for (let idx = 0; idx < a.triggers.length; idx++) {
        const spec = TriggerSpec.safeParse(a.triggers[idx]);
        if (!spec.success) continue; // invalid entries are rejected by the API; old data is skipped
        let holding: boolean;
        let detail: Record<string, unknown> | undefined;
        try {
          const ev = await evaluate(spec.data, this.data, null);
          holding = ev.fired;
          detail = ev.detail;
        } catch {
          continue; // data unavailable this pass: keep the previous state
        }
        const prev = states.get(idx);
        const recently = prev?.lastFiredAt && this.now().getTime() - prev.lastFiredAt.getTime() < TRIGGER_MIN_INTERVAL_MS;
        const edge = holding && !prev?.holding && !recently;
        let lastFiredAt = prev?.lastFiredAt ?? null;
        if (edge) {
          const woke = await this.store.wake(a.agentId, { trigger: idx, condition: spec.data.condition, spec: spec.data, detail: detail ?? {}, at: this.now().toISOString() });
          lastFiredAt = this.now();
          fired.push({ agentId: a.agentId, idx, woke });
        }
        // while rate-limited, stay "not holding" so the edge is seen again once the interval has passed
        await this.store.saveState(a.agentId, { idx, configVersion: a.configVersion, holding: holding && (edge || !!prev?.holding), lastFiredAt });
      }
    }
    return fired;
  }
}

export class PgTriggerStore implements TriggerStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async agents(): Promise<TriggerAgent[]> {
    const r = await this.pool.query<{ agent_id: string; version: number; triggers: unknown[] }>(
      `SELECT c.agent_id, c.version, c.triggers FROM agents a
         JOIN LATERAL (SELECT agent_id, version, triggers FROM agent_configs WHERE agent_id = a.id ORDER BY version DESC LIMIT 1) c ON true
        WHERE a.status = 'active' AND jsonb_array_length(c.triggers) > 0`,
    );
    return r.rows.map((x) => ({ agentId: x.agent_id, configVersion: x.version, triggers: x.triggers }));
  }

  async states(agentId: string): Promise<TriggerState[]> {
    const r = await this.pool.query<{ idx: number; config_version: number; holding: boolean; last_fired_at: Date | null }>(
      'SELECT idx, config_version, holding, last_fired_at FROM agent_trigger_state WHERE agent_id = $1',
      [agentId],
    );
    return r.rows.map((x) => ({ idx: x.idx, configVersion: x.config_version, holding: x.holding, lastFiredAt: x.last_fired_at }));
  }

  async saveState(agentId: string, s: TriggerState): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_trigger_state (agent_id, idx, config_version, holding, last_fired_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, idx) DO UPDATE SET config_version = EXCLUDED.config_version, holding = EXCLUDED.holding, last_fired_at = EXCLUDED.last_fired_at`,
      [agentId, s.idx, s.configVersion, s.holding, s.lastFiredAt],
    );
  }

  async wake(agentId: string, reason: Record<string, unknown>): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO agent_schedule (agent_id, next_tick_at, wake_reason) VALUES ($1, now(), $2)
       ON CONFLICT (agent_id) DO UPDATE SET next_tick_at = LEAST(agent_schedule.next_tick_at, now()), wake_reason = EXCLUDED.wake_reason
         WHERE agent_schedule.lease_until IS NULL OR agent_schedule.lease_until < now()`,
      [agentId, JSON.stringify(reason)],
    );
    return r.rowCount === 1;
  }
}
