import { HEALTH_PORTS, Health } from '@odin/shared';
import { createPool } from '@odin/db';
import { PgTokenMeter, providersFromEnv } from '@odin/decision';
import { SignalEngine } from './ai.ts';
import { PgRuleData, SignalsService } from './service.ts';

const rpcUrls = (process.env.CHAIN_RPC_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 4 });
// without an LLM credential, AI signal runs fail (recorded per profile); rule alerts still work
const providers = providersFromEnv(process.env, 'medium');
const service = new SignalsService({
  pool,
  data: new PgRuleData(pool, rpcUrls),
  engine: new SignalEngine({ providers, meter: new PgTokenMeter(pool), dailyTokenBudget: Number(process.env.DECISION_DAILY_TOKEN_BUDGET ?? 2_000_000) }),
});
const log = (o: object) => console.log(JSON.stringify(o));
log({ msg: 'signals up', ai: providers.map((p) => p.name) });
const health = new Health('signals', 300000).listen(HEALTH_PORTS.signals);

for (;;) {
  health.beat();
  try {
    const r = await service.evaluateRules();
    if (r.fired || r.errors) log({ msg: 'rules', ...r });
    const s = await service.runProfiles();
    if (s.ran) log({ msg: 'ai signals', ...s });
  } catch (e) {
    health.fail((e as Error).message);
    log({ msg: 'signals pass failed', error: (e as Error).message });
  }
  await new Promise((res) => setTimeout(res, 15_000));
}
