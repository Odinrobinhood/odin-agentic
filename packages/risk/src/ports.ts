import type { Address, Hex } from 'viem';
import type { AgentRiskContext, Mode } from './types.ts';

/** Persistent state the Risk Engine reads (Postgres in production). */
export interface RiskStore {
  loadAgent(agentId: string): Promise<AgentRiskContext | null>;
  /** Stored route from `token` to `quote` (sell direction), or null when the token has no route. */
  route(token: Address, quote: Address): Promise<Hex | null>;
  /** Agent-originated buy/sell decisions today that were not rejected, excluding `excludeDecisionId`. */
  tradesToday(agentId: string, mode: Mode, dayStart: Date, excludeDecisionId?: string): Promise<number>;
  /**
   * NAV (whole quote units) recorded at the first evaluation of `day` (YYYY-MM-DD, UTC).
   * Stores `currentNav` if no baseline exists yet and returns the stored value.
   */
  dayBaseline(agentId: string, mode: Mode, day: string, currentNav: number): Promise<number>;
}

/** Balances of the agent wallet. Live reads the chain; paper reads the paper ledger. */
export interface BalanceReader {
  token(ctx: AgentRiskContext, token: Address): Promise<bigint>;
  /** Native ETH for gas. */
  native(ctx: AgentRiskContext): Promise<bigint>;
}

export interface RiskChain {
  /** Mid price along a path from slot0, raw units of the last token per raw unit of the first. Fees excluded. */
  midRate(path: Hex): Promise<number>;
  /** QuoterV2 quoteExactInput: output amount for amountIn, fees and price impact included. */
  quoteExactInput(path: Hex, amountIn: bigint): Promise<bigint>;
  /** Oracle price, whole quote units per whole token, or null when no (fresh) feed covers the pair. */
  refereePrice(token: Address, quote: Address): Promise<number | null>;
  /** Robinhood Stock Tokens: paused() or tokenPaused() (verified on-chain 2026-11-10; there is no per-wallet blocklist). */
  isPaused(token: Address): Promise<boolean>;
}
