import { getAddress, type Address } from 'viem';
import { isOdinChainId } from '@odin/shared';
import type { RoutingConfig } from './routing.ts';

export type MarketConfig = RoutingConfig & {
  chainId: number;
  rpcUrls: string[];
  factory: Address;
  quoter: Address;
  databaseUrl: string;
  snapshotEveryMs: number;
  refreshRoutesEveryMs: number;
};

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

/** Reads the shared app chain config (deploy/chain.mainnet.env). */
export function loadMarketConfig(env: NodeJS.ProcessEnv = process.env): MarketConfig {
  const chainId = Number(req(env, 'CHAIN_ID'));
  if (!isOdinChainId(chainId)) throw new Error(`CHAIN_ID ${chainId} is not Robinhood Chain`);
  const usdg = getAddress(req(env, 'CHAIN_USDG'));
  const weth = getAddress(req(env, 'CHAIN_WETH'));
  return {
    chainId,
    rpcUrls: req(env, 'CHAIN_RPC_URLS').split(',').map((s) => s.trim()).filter(Boolean),
    factory: getAddress(req(env, 'CHAIN_FACTORY')),
    quoter: getAddress(req(env, 'CHAIN_QUOTER_V2')),
    usdg,
    weth,
    probeQuote: new Map([
      [usdg, Number(env.MARKET_PROBE_USDG ?? 1000)],
      [weth, Number(env.MARKET_PROBE_WETH ?? 0.5)],
    ]),
    databaseUrl: env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql',
    snapshotEveryMs: 60_000, // architecture §3.3: snapshot resolution = cadence floor
    refreshRoutesEveryMs: Number(env.MARKET_REFRESH_ROUTES_MS ?? 15 * 60_000),
  };
}
