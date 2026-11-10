import { getAddress } from 'viem';
import { createPool } from '@odin/db';
import { ClaudeProvider, DecisionEngine, PgTokenMeter } from '@odin/decision';
import { BacktestWorker } from './worker.ts';

const pool = createPool(process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: 3 });
// backtest calls count against the user's daily LLM budget like live decisions
const engine = new DecisionEngine({
  providers: [new ClaudeProvider({ effort: (process.env.DECISION_EFFORT ?? 'high') as 'high' })],
  meter: new PgTokenMeter(pool),
  config: { dailyTokenBudget: Number(process.env.DECISION_DAILY_TOKEN_BUDGET ?? 2_000_000) },
});
const worker = new BacktestWorker({ pool, decide: (ctx) => engine.decide(ctx), usdg: getAddress(process.env.CHAIN_USDG!) });
const log = (o: object) => console.log(JSON.stringify(o));
log({ msg: 'backtest worker up' });

for (;;) {
  try {
    const r = await worker.runNext();
    if (r) log({ msg: 'backtest', ...r });
    else await new Promise((res) => setTimeout(res, 5_000));
  } catch (e) {
    log({ msg: 'backtest pass failed', error: (e as Error).message });
    await new Promise((res) => setTimeout(res, 5_000));
  }
}
