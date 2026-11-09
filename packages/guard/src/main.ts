import { buildGuard } from './wiring.ts';

const { watcher } = buildGuard();
const POLL_MS = Number(process.env.GUARD_POLL_MS ?? 3_000);
const log = (o: object) => console.log(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
log({ msg: 'guard watcher up', pollMs: POLL_MS });

for (;;) {
  try {
    for (const e of await watcher.checkOnce()) log({ msg: 'guard', ...e });
    for (const c of await watcher.processCloseRequests()) log({ msg: 'close all', ...c });
  } catch (e) {
    log({ msg: 'guard pass failed', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
