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

/** Any approval at or above this value is the "unlimited" idiom and is always rejected. */
export const UNLIMITED_APPROVAL_THRESHOLD = 2n ** 255n;
