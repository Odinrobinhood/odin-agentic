import { readFileSync } from 'node:fs';
import { getAddress, type Address } from 'viem';
import { isOdinChainId, type OdinChainId } from '@odin/shared';

export type SignerConfig = {
  chainId: OdinChainId;
  rpcUrls: string[];
  /** SwapRouter02, pinned here — never taken from a request, the API or the DB. */
  router: Address;
  factory: Address;
  /** The only tokens allowed as intermediate hops. */
  usdg: Address;
  weth: Address;
  seedFile: string;
  databaseUrl: string;
  agentListen: string;
  guardListen: string;
  agentToken: string;
  guardToken: string;
  agentDailyCap: number;
  /** Floor for the guard quota; the effective quota also scales with open positions. */
  guardDailyCapFloor: number;
  deadlineSeconds: number;
  maxGasLimit: bigint;
  maxFeePerGas: bigint;
};

export const MAX_DEADLINE_SECONDS = 300;
export const MAX_HOPS = 3;

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`env ${key} must be a non-negative integer`);
  return n;
}

function readSecretFile(path: string): string {
  const v = readFileSync(path, 'utf8').trim();
  if (v.length < 32) throw new Error(`secret in ${path} is too short (min 32 chars)`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const chainId = Number(req(env, 'SIGNER_CHAIN_ID'));
  if (!isOdinChainId(chainId)) throw new Error(`SIGNER_CHAIN_ID ${chainId} is not Robinhood Chain (4663 / 46630)`);

  const deadlineSeconds = int(env, 'SIGNER_DEADLINE_SECONDS', 60);
  if (deadlineSeconds < 10 || deadlineSeconds > MAX_DEADLINE_SECONDS) {
    throw new Error(`SIGNER_DEADLINE_SECONDS must be between 10 and ${MAX_DEADLINE_SECONDS}`);
  }

  const rpcUrls = req(env, 'SIGNER_RPC_URLS').split(',').map((s) => s.trim()).filter(Boolean);
  if (rpcUrls.length === 0) throw new Error('SIGNER_RPC_URLS is empty');

  return {
    chainId,
    rpcUrls,
    router: getAddress(req(env, 'SIGNER_ROUTER')),
    factory: getAddress(req(env, 'SIGNER_FACTORY')),
    usdg: getAddress(req(env, 'SIGNER_USDG')),
    weth: getAddress(req(env, 'SIGNER_WETH')),
    seedFile: req(env, 'SIGNER_SEED_FILE'),
    databaseUrl: req(env, 'SIGNER_DATABASE_URL'),
    agentListen: env.SIGNER_AGENT_LISTEN ?? '127.0.0.1:7401',
    guardListen: env.SIGNER_GUARD_LISTEN ?? '127.0.0.1:7402',
    agentToken: readSecretFile(req(env, 'SIGNER_AGENT_TOKEN_FILE')),
    guardToken: readSecretFile(req(env, 'SIGNER_GUARD_TOKEN_FILE')),
    agentDailyCap: int(env, 'SIGNER_AGENT_DAILY_CAP', 200),
    guardDailyCapFloor: int(env, 'SIGNER_GUARD_DAILY_CAP_FLOOR', 30),
    deadlineSeconds,
    maxGasLimit: BigInt(int(env, 'SIGNER_MAX_GAS_LIMIT', 5_000_000)),
    maxFeePerGas: BigInt(req(env, 'SIGNER_MAX_FEE_PER_GAS_WEI')),
  };
}
