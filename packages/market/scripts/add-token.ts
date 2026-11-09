/** Register a token by address: node packages/market/scripts/add-token.ts <address> (chain env loaded). */
import { createPool } from '@odin/db';
import { loadMarketConfig, PgMarketStore, TokenRegistry, ViemMarketChain } from '../src/index.ts';

const cfg = loadMarketConfig();
const pool = createPool(cfg.databaseUrl, { max: 2 });
const registry = new TokenRegistry(new ViemMarketChain(cfg), new PgMarketStore(pool), cfg);
try {
  await registry.ensureBaseAssets();
  const r = await registry.addToken(process.argv[2] ?? '');
  console.log(JSON.stringify({ token: r.token, routes: r.routes.map((x) => ({ quote: x.quote, path: x.path, fees: x.fees })) }));
} catch (e) {
  console.log(JSON.stringify({ error: { code: (e as { code?: string }).code ?? 'internal_error', message: (e as Error).message } }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
