import { HEALTH_PORTS, Health } from '@odin/shared';
import { createPool } from '@odin/db';
import { loadMarketConfig } from './config.ts';
import { ViemMarketChain } from './chain.ts';
import { PgMarketStore } from './store.ts';
import { TokenRegistry } from './registry.ts';
import { takeSnapshot } from './snapshot.ts';

const cfg = loadMarketConfig();
const chain = new ViemMarketChain(cfg);
const store = new PgMarketStore(createPool(cfg.databaseUrl, { max: 4 }));
const registry = new TokenRegistry(chain, store, cfg);
const log = (o: object) => console.log(JSON.stringify(o));

await registry.ensureBaseAssets();
log({ msg: 'market up', chainId: cfg.chainId });
const health = new Health('market', 180000).listen(HEALTH_PORTS.market);

let lastRefresh = 0;
for (;;) {
  health.beat();
  const started = Date.now();
  try {
    if (started - lastRefresh >= cfg.refreshRoutesEveryMs) {
      const r = await registry.refreshRoutes();
      lastRefresh = started;
      log({ msg: 'routes refreshed', ...r });
    }
    const s = await takeSnapshot(chain, store, cfg, new Date(started));
    log({ msg: 'snapshot', rows: s.rows.length, failed: s.failed });
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'tick failed', error: (e as Error).message });
  }
  // next minute boundary
  const wait = cfg.snapshotEveryMs - (Date.now() % cfg.snapshotEveryMs) + 500;
  await new Promise((r) => setTimeout(r, wait));
}
