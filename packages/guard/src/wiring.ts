import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { createPool } from '@odin/db';
import { Executor, FallbackChain, HttpSignerClient, PgExecutionStore, loadExecutorConfig } from '@odin/executor';
import { DEFAULT_RISK_CONFIG, PgRiskStore, RiskEngine, ViemBalanceReader, ViemRiskChain } from '@odin/risk';
import { PgPaperBalances, PgRuntimeStore } from '@odin/runtime';
import { PgGuardStore } from './store.ts';
import { GuardWatcher } from './watcher.ts';

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

/**
 * Wire the Guard Watcher. It runs as OS user odin-guard: its own DB role (peer map) and the signer's
 * GUARD channel token, neither of which the API or runtime processes can use.
 */
export function buildGuard(env: NodeJS.ProcessEnv = process.env) {
  const pool = createPool(env.GUARD_DATABASE_URL ?? 'postgresql://odin_guard@/odin?host=/var/run/postgresql', { max: 6 });
  const rpcUrls = req(env, 'CHAIN_RPC_URLS').split(',').map((s) => s.trim()).filter(Boolean);
  const usdg = getAddress(req(env, 'CHAIN_USDG'));
  const chain = new ViemRiskChain({ rpcUrls, factory: getAddress(req(env, 'CHAIN_FACTORY')), quoter: getAddress(req(env, 'CHAIN_QUOTER_V2')), referees: new Map([[usdg, { fixedUsd: 1 }]]) });
  const risk = new RiskEngine({
    config: { ...DEFAULT_RISK_CONFIG, usdg, weth: getAddress(req(env, 'CHAIN_WETH')), gasReserveWei: BigInt(env.RUNTIME_GAS_RESERVE_WEI ?? '500000000000000') },
    store: new PgRiskStore(pool),
    chain,
    balances: { live: new ViemBalanceReader(rpcUrls), paper: new PgPaperBalances(pool) },
  });
  const exCfg = loadExecutorConfig(env);
  const executor = new Executor({
    config: exCfg,
    chain: new FallbackChain(exCfg.rpcUrls),
    signer: new HttpSignerClient(req(env, 'SIGNER_GUARD_URL'), readFileSync(req(env, 'SIGNER_GUARD_TOKEN_FILE'), 'utf8').trim()),
    store: new PgExecutionStore(pool),
  });
  const watcher = new GuardWatcher({
    store: new PgGuardStore(pool),
    runtime: new PgRuntimeStore(pool),
    quote: (path, amountIn) => chain.quoteExactInput(path, amountIn),
    risk,
    executor,
  });
  return { pool, watcher };
}
