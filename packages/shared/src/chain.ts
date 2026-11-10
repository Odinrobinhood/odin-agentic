export const CHAIN_IDS = { mainnet: 4663, testnet: 46630 } as const;
export type OdinChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

export function isOdinChainId(id: number): id is OdinChainId {
  return id === CHAIN_IDS.mainnet || id === CHAIN_IDS.testnet;
}

/** Valid Uniswap v3 fee tiers (hundredths of a bip). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export type FeeTier = (typeof FEE_TIERS)[number];

export function isFeeTier(fee: number): fee is FeeTier {
  return (FEE_TIERS as readonly number[]).includes(fee);
}

/**
 * Robinhood Stock Tokens are EIP-1967 beacon proxies of this beacon (verified on-chain 2026-11-10 for NVDA,
 * TSLA, AAPL, SPCX, GLD, ...). Exposing paused()/tokenPaused() is NOT proof: anyone can deploy that.
 */
export const ROBINHOOD_STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00';
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** Any approval at or above this value is the "unlimited" idiom and is always rejected. */
export const UNLIMITED_APPROVAL_THRESHOLD = 2n ** 255n;
