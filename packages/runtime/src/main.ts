import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildRuntime } from './wiring.ts';
import { PgSchedule } from './scheduler.ts';
import { runTick } from './tick.ts';

const { pool, deps } = buildRuntime();
const schedule = new PgSchedule(pool);
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const CONCURRENCY = Number(process.env.RUNTIME_CONCURRENCY ?? 8);
const LEASE_MS = 5 * 60_000; // longer than any tick: LLM call + approve + swap until deadline
const log = (o: object) => console.log(JSON.stringify(o));

log({ msg: 'runtime up', owner, concurrency: CONCURRENCY });
const running = new Set<string>();

for (;;) {
  try {
    await schedule.enroll();
    const free = CONCURRENCY - running.size;
    const due = free > 0 ? await schedule.claimDue(owner, free, LEASE_MS) : [];
    for (const agentId of due) {
      running.add(agentId);
      void (async () => {
        let error: string | undefined;
        try {
          const r = await runTick(deps, agentId);
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
    log({ msg: 'scheduler error', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, 1_000));
}
