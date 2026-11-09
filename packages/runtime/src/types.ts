import type { Address } from 'viem';
import type { AssetInfo } from '@odin/decision';
import type { Mode } from '@odin/risk';

export type ContextInputs = {
  /** OHLC candles from minute snapshots; omit or count 0 to leave them out. */
  candles?: { period_minutes: number; count: number };
  /** How many recent decisions (with rationale and rejection codes) to include. */
  history?: number;
};

export type TpSlDefaults = {
  slEnabled: boolean;
  slMode: 'pct' | 'price' | null;
  slValue: number | null;
  tpEnabled: boolean;
  tpMode: 'pct' | 'price' | null;
  tpValue: number | null;
};

export type AgentRuntimeState = {
  agentId: string;
  userId: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  mode: Mode;
  wallet: Address;
  config: {
    version: number;
    mandate: string;
    modelName: string;
    maxTokens: number;
    contextInputs: ContextInputs;
    cadenceSeconds: number;
  };
  quote: AssetInfo;
  assets: AssetInfo[];
  tpSl: TpSlDefaults | null;
};

export type MarketState = {
  snapshotId: number | null;
  snapshotTs: Date | null;
  /** USDG per whole token. */
  pricesUsdg: Map<Address, number>;
  candles: Map<Address, { t: string; o: number; h: number; l: number; c: number }[]>;
};

export type PositionRow = { token: Address; qty: bigint; avgEntryPrice: number };

export type DecisionRow = {
  agentId: string;
  configVersion: number | null;
  snapshotId: number | null;
  mode: Mode;
  origin: 'agent' | 'guard' | 'user_close';
  action: 'buy' | 'sell' | 'hold';
  token: Address | null;
  size: unknown;
  rationale: string | null;
  thesis: unknown;
  confidence: number | null;
  model: string | null;
  promptHash: string | null;
  responseHash: string | null;
  tokensUsed: number;
};

export type Fill = { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint };

export interface RuntimeStore {
  loadAgent(agentId: string): Promise<AgentRuntimeState | null>;
  market(tokens: Address[], candles: ContextInputs['candles']): Promise<MarketState>;
  positions(agentId: string, mode: Mode): Promise<PositionRow[]>;
  recentDecisions(agentId: string, n: number): Promise<unknown[]>;
  insertDecision(row: DecisionRow): Promise<string>;
  insertRejection(decisionId: string, code: string, message: string): Promise<void>;
  recordPaperFill(decisionId: string, fill: Fill): Promise<void>;
  /**
   * Step 7–8: update positions from a fill and (re)arm the agent's default TP/SL guards on what is held.
   * Paper mode also moves the paper quote balance, which is kept as a position in the quote asset.
   */
  applyFill(agent: AgentRuntimeState, fill: Fill): Promise<void>;
  /** Queue a notification (architecture §3.11); the owner is resolved from payload.agentId. */
  alert(sourceId: string, payload: Record<string, unknown> & { agentId: string; event: string }): Promise<void>;
}
