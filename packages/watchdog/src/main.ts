import { HEALTH_PORTS, Health } from '@odin/shared';
import { createPool } from '@odin/db';
import { PgAlertSink, PgWatchdogData } from './pg.ts';
import { Watchdog } from './watchdog.ts';

const rpcUrls = (process.env.CHAIN_RPC_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
const watchdog = new Watchdog({
  data: new PgWatchdogData(pool, rpcUrls, process.env.WATCHDOG_SERVICES ? process.env.WATCHDOG_SERVICES.split(',').map((s) => s.trim()) : undefined),
  sink: new PgAlertSink(pool),
  config: process.env.WATCHDOG_LOW_GAS_WEI ? { lowGasWei: BigInt(process.env.WATCHDOG_LOW_GAS_WEI) } : {},
});
const log = (o: object) => console.log(JSON.stringify(o));
log({ msg: 'watchdog up' });
const health = new Health('watchdog', 300000).listen(HEALTH_PORTS.watchdog);

for (;;) {
  health.beat();
  try {
    const findings = await watchdog.runOnce();
    for (const f of findings.filter((x) => x.sent)) log({ msg: 'alert', key: f.key, event: f.event });
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'watchdog pass failed', error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
