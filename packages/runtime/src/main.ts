import { HEALTH_PORTS, Health } from '@odin/shared';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildRuntime } from './wiring.ts';
import { PgSchedule } from './scheduler.ts';
import { runTick } from './tick.ts';
import { PgTriggerStore, TriggerWatcher } from './triggers.ts';
import { PgRuleData } from '@odin/signals';

const { pool, deps } = buildRuntime();
const schedule = new PgSchedule(pool);
const triggers = new TriggerWatcher({ store: new PgTriggerStore(pool), data: new PgRuleData(pool, (process.env.CHAIN_RPC_URLS ?? '').split(',').filter(Boolean)) });
let lastTriggerCheck = 0;
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
// Ticks spend almost all their time waiting for the model, so concurrency, not CPU, sets capacity:
// needed ≈ agents × tick seconds / cadence seconds. Load test 2026-11-11 (2 vCPU staging): 8 → 69 ticks/min
// (300 agents lagged ~3 min); 48 → every agent on time, 15 CPU-s in 8 min, 169 MB, ≤ 10 DB connections.
const CONCURRENCY = Number(process.env.RUNTIME_CONCURRENCY ?? 48);
const LEASE_MS = 5 * 60_000; // longer than any tick: LLM call + approve + swap until deadline
const log = (o: object) => console.log(JSON.stringify(o));

log({ msg: 'runtime up', owner, concurrency: CONCURRENCY });
const health = new Health('runtime', 60000).listen(HEALTH_PORTS.runtime);
const running = new Set<string>();

for (;;) {
  health.beat();
  try {
    await schedule.enroll();
    if (Date.now() - lastTriggerCheck >= 15_000) {
      lastTriggerCheck = Date.now();
      for (const t of await triggers.checkOnce().catch(() => [])) log({ msg: 'trigger', ...t });
    }
    const free = CONCURRENCY - running.size;
    const due = free > 0 ? await schedule.claimDue(owner, free, LEASE_MS) : [];
    for (const agentId of due) {
      running.add(agentId);
      void (async () => {
        let error: string | undefined;
        try {
          const r = await runTick(deps, agentId, { wake: await schedule.takeWakeReason(agentId) });
          log({ msg: 'tick', agentId, ...r, ...('amountIn' in r ? { amountIn: r.amountIn.toString(), amountOut: r.amountOut.toString() } : {}) });
        } catch (e) {
          error = (e as Error).message.slice(0, 500);
          log({ msg: 'tick error', agentId, error });
        } finally {
          const { paused } = await schedule.complete(agentId, owner, { error }).catch(() => ({ paused: false }));
          if (paused) log({ msg: 'agent paused after repeated errors', agentId });
          running.delete(agentId);
        }
      })();
    }
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'scheduler error', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, 1_000));
}
