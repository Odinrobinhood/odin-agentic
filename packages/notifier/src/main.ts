import { HEALTH_PORTS, Health } from '@odin/shared';
import { createPool } from '@odin/db';
import { Notifier, PgNotifyStore } from './notifier.ts';

// In-app only (decided by the user 2026-11-10: no external notifications). Alerts land in the web app's
// notification feed; operator alerts (payload.operator) are kept in alert_events and this log.
const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const notifier = new Notifier(new PgNotifyStore(pool), []);
const log = (o: object) => console.log(JSON.stringify(o));
log({ msg: 'notifier up', channels: ['in_app'] });
const health = new Health('notifier', 60000).listen(HEALTH_PORTS.notifier);

for (;;) {
  health.beat();
  try {
    const r = await notifier.deliverOnce();
    if (r.delivered || r.failed) log({ msg: 'notify', ...r });
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'notify pass failed', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
