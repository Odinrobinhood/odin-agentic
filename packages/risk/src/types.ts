import type { Address, Hex } from 'viem';
import type { RejectionCode } from '@odin/shared';

export type Origin = 'agent' | 'guard' | 'user_close';
export type Mode = 'live' | 'paper';
export type AgentStatus = 'draft' | 'active' | 'paused' | 'retired';

/** Mirrors the Decision Engine output `size` (architecture §3.5). Values are string decimals. */
export type TradeSize = { type: 'quote_amount' | 'fraction_of_position'; value: string };

export type RiskIntent = {
  agentId: string;
  /** The decision row this intent belongs to, so it is not counted against its own trades-per-day limit. */
  decisionId?: string;
  mode: Mode;
  origin: Origin;
  action: 'buy' | 'sell';
  token: Address;
  size: TradeSize;
  /** Guard origin only: when the guard first triggered and the user's deviation timeout (§3.7). */
  guard?: { firstTriggeredAt: Date; deviationTimeoutSeconds: number };
};

/** All optional; null = the user has not enabled that limit (architecture §5 risk_profiles). */
export type RiskProfile = {
  maxPositionPct: number | null;
  maxExposurePct: number | null;
  maxDailyLossPct: number | null;
  maxTradesPerDay: number | null;
  maxSlippageBps: number | null;
};

export const NO_LIMITS: RiskProfile = {
  maxPositionPct: null,
  maxExposurePct: null,
  maxDailyLossPct: null,
  maxTradesPerDay: null,
  maxSlippageBps: null,
};

export type AgentRiskContext = {
  agentId: string;
  status: AgentStatus;
  wallet: Address;
  quoteAsset: Address;
  assets: Set<Address>;
  /** Stock Tokens among the assets, held tokens and quote asset; these get paused()/tokenPaused() checks. */
  stockTokens: Set<Address>;
  /**
   * Tokens with an open position (qty > 0) per mode, the quote asset excluded. A guard or user exit
   * may sell these even after the user removed them from `assets` (architecture §3.7).
   */
  held: Record<Mode, Set<Address>>;
  /** Decimals of every asset, every held token and the quote asset. */
  decimals: Map<Address, number>;
  profile: RiskProfile;
};

export type RiskApproved = {
  ok: true;
  tokenIn: Address;
  tokenOut: Address;
  path: Hex;
  amountIn: bigint;
  /** Quoter output at amountIn (fees and price impact included). */
  expectedOut: bigint;
  amountOutMin: bigint;
  slippageBps: number;
  /** Pool mid price, whole quote units per whole token. */
  poolPrice: number;
  /** Referee (oracle) price in the same units, or null when no feed exists for the pair. */
  refereePrice: number | null;
  deviationBps: number | null;
  /** Checks that failed but were deliberately overridden (only guard deviation timeout). */
  overrides: 'price_deviation_timeout'[];
};

export type RiskRejected = {
  ok: false;
  code: RejectionCode;
  message: string;
  /** 0 = agent state / request shape, 1-5 = architecture §3.7 check number. */
  check: 0 | 1 | 2 | 3 | 4 | 5;
};

export type RiskResult = RiskApproved | RiskRejected;
