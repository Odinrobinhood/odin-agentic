import { getAddress } from 'viem';
import type { ExecutorConfig } from './executor.ts';

function big(env: NodeJS.ProcessEnv, key: string, def: bigint): bigint {
  const v = env[key];
  if (v === undefined || v === '') return def;
  if (!/^[0-9]+$/.test(v)) throw new Error(`env ${key} must be an unsigned integer`);
  return BigInt(v);
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

export type ExecutorEnv = ExecutorConfig & { rpcUrls: string[] };

/** Reads the same pinned router as the signer (EXECUTOR_ROUTER must equal SIGNER_ROUTER). */
export function loadExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorEnv {
  const rpcUrls = req(env, 'EXECUTOR_RPC_URLS').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    rpcUrls,
    router: getAddress(req(env, 'EXECUTOR_ROUTER')),
    gas: {
      approve: big(env, 'EXECUTOR_GAS_APPROVE', 300_000n),
      swapBase: big(env, 'EXECUTOR_GAS_SWAP_BASE', 600_000n),
      swapPerHop: big(env, 'EXECUTOR_GAS_SWAP_PER_HOP', 400_000n),
    },
    baseFeeMultiplier: big(env, 'EXECUTOR_BASE_FEE_MULTIPLIER', 2n),
    priorityFee: big(env, 'EXECUTOR_PRIORITY_FEE_WEI', 0n),
    maxFeePerGas: big(env, 'EXECUTOR_MAX_FEE_PER_GAS_WEI', 1_000_000_000n),
    approveTimeoutMs: Number(big(env, 'EXECUTOR_APPROVE_TIMEOUT_MS', 60_000n)),
    deadlineGraceMs: Number(big(env, 'EXECUTOR_DEADLINE_GRACE_MS', 5_000n)),
    pollMs: Number(big(env, 'EXECUTOR_POLL_MS', 250n)),
  };
}
