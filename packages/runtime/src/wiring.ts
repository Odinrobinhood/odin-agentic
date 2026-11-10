import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { createPool, type Pool } from '@odin/db';
import { DecisionEngine, PgTokenMeter, providersFromEnv, type DecisionProvider } from '@odin/decision';
import { Executor, FallbackChain, HttpSignerClient, PgExecutionStore, loadExecutorConfig } from '@odin/executor';
import { DEFAULT_RISK_CONFIG, PgRiskStore, RiskEngine, ViemBalanceReader, ViemRiskChain, loadReferees } from '@odin/risk';
import { isOdinChainId } from '@odin/shared';
import { PgPaperBalances, PgRuntimeStore } from './store.ts';
import type { TickDeps } from './tick.ts';

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

/**
 * Wire every component for the runtime process from the shared chain config (deploy/chain.mainnet.env).
 * `providers` can be overridden (staging checks use a scripted provider); the default is Claude.
 */
export function buildRuntime(env: NodeJS.ProcessEnv = process.env, opts: { providers?: DecisionProvider[]; pool?: Pool } = {}) {
  const chainId = Number(req(env, 'CHAIN_ID'));
  if (!isOdinChainId(chainId)) throw new Error(`CHAIN_ID ${chainId} is not Robinhood Chain`);
  const rpcUrls = req(env, 'CHAIN_RPC_URLS').split(',').map((s) => s.trim()).filter(Boolean);
  const usdg = getAddress(req(env, 'CHAIN_USDG'));
  const weth = getAddress(req(env, 'CHAIN_WETH'));
  const pool = opts.pool ?? createPool(env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql', { max: Number(env.RUNTIME_DB_POOL_MAX ?? 10) });

  const balances = { live: new ViemBalanceReader(rpcUrls), paper: new PgPaperBalances(pool) };
  const risk = new RiskEngine({
    config: { ...DEFAULT_RISK_CONFIG, usdg, weth, gasReserveWei: BigInt(env.RUNTIME_GAS_RESERVE_WEI ?? '500000000000000') },
    store: new PgRiskStore(pool),
    // check 5 referees: USDG fixed at 1, verified Chainlink feeds from CHAINLINK_FEEDS_FILE; tokens without a feed skip it
    chain: new ViemRiskChain({ rpcUrls, factory: getAddress(req(env, 'CHAIN_FACTORY')), quoter: getAddress(req(env, 'CHAIN_QUOTER_V2')), referees: loadReferees(env.CHAINLINK_FEEDS_FILE, usdg) }),
    balances,
  });

  const exCfg = loadExecutorConfig(env);
  const executor = new Executor({
    config: exCfg,
    chain: new FallbackChain(exCfg.rpcUrls),
    signer: new HttpSignerClient(req(env, 'SIGNER_AGENT_URL'), readFileSync(req(env, 'SIGNER_AGENT_TOKEN_FILE'), 'utf8').trim()),
    store: new PgExecutionStore(pool),
  });

  const effort = (env.DECISION_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  const decision = new DecisionEngine({
    providers: opts.providers ?? providersFromEnv(env, effort),
    meter: new PgTokenMeter(pool),
    config: { dailyTokenBudget: Number(env.DECISION_DAILY_TOKEN_BUDGET ?? 2_000_000) },
  });

  const store = new PgRuntimeStore(pool);
  const deps: TickDeps = { store, decide: (ctx) => decision.decide(ctx), risk, executor, balances };
  return { pool, store, deps, usdg, weth };
}
