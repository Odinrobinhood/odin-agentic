import { HEALTH_PORTS, Health } from '@odin/shared';
import { buildGuard } from './wiring.ts';

const { watcher } = buildGuard();
const POLL_MS = Number(process.env.GUARD_POLL_MS ?? 3_000);
const log = (o: object) => console.log(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
log({ msg: 'guard watcher up', pollMs: POLL_MS });
const health = new Health('guard', 60000).listen(HEALTH_PORTS.guard);

for (;;) {
  health.beat();
  try {
    for (const e of await watcher.checkOnce()) log({ msg: 'guard', ...e });
    for (const c of await watcher.processCloseRequests()) log({ msg: 'close all', ...c });
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'guard pass failed', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
