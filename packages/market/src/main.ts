import { HEALTH_PORTS, Health } from '@odin/shared';
import { createPool } from '@odin/db';
import { loadMarketConfig } from './config.ts';
import { ViemMarketChain } from './chain.ts';
import { PgMarketStore } from './store.ts';
import { TokenRegistry } from './registry.ts';
import { takeSnapshot } from './snapshot.ts';
import { CatalogEnricher, PoolDiscovery, ViemDiscoveryChain } from './catalog.ts';

const cfg = loadMarketConfig();
const chain = new ViemMarketChain(cfg);
const pool = createPool(cfg.databaseUrl, { max: 6 });
const store = new PgMarketStore(pool);
const registry = new TokenRegistry(chain, store, cfg);
const log = (o: object) => console.log(JSON.stringify(o));

await registry.ensureBaseAssets();
log({ msg: 'market up', chainId: cfg.chainId });
const health = new Health('market', 180000).listen(HEALTH_PORTS.market);

// token catalog (every pool on the chain, so users can pick any token): runs beside the minute snapshots
const discoveryChain = new ViemDiscoveryChain(cfg.rpcUrls);
const discovery = new PoolDiscovery({ pool, chain: discoveryChain, factory: cfg.factory });
const enricher = new CatalogEnricher({ pool, chain: discoveryChain, market: chain, usdg: cfg.usdg, weth: cfg.weth });
// two independent loops: discovery must not wait for metadata reads of thousands of tokens
const background = (name: string, fn: () => Promise<boolean>) =>
  void (async () => {
    for (;;) {
      try {
        // fn returns true when there is more work right away
        if (!(await fn())) await new Promise((r) => setTimeout(r, 30_000));
      } catch (e) {
        log({ msg: `${name} step failed`, error: (e as Error).message.split('\n')[0] });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  })();
background('pool discovery', async () => {
  const d = await discovery.step();
  if (d.found) log({ msg: 'pools discovered', found: d.found, toBlock: d.toBlock.toString() });
  return !d.caughtUp;
});
background('catalog', async () => {
  const n = await enricher.step(40);
  if (n) log({ msg: 'catalog enriched', tokens: n });
  return n > 0;
});

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
