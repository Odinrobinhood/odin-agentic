import { z } from 'zod';
import type { Address } from 'viem';

const decimalString = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'decimal string');

/** Decision Engine output (architecture §3.5). Strictly validated; nothing outside it reaches the Risk Engine. */
export const DecisionSchema = z
  .object({
    action: z.enum(['buy', 'sell', 'hold']),
    /** Contract address from the agent's allowed assets; null for hold. */
    token: z.string().nullable(),
    size: z
      .object({
        type: z.enum(['quote_amount', 'fraction_of_position']),
        value: decimalString,
      })
      .strict()
      .nullable(),
    rationale: z.string(),
    thesis: z
      .object({
        claim: z.string(),
        horizon_ticks: z.number().int().min(0),
        invalidated_if: z.string(),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;

/** JSON schema sent as the structured-output format (mirrors DecisionSchema). */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'token', 'size', 'rationale', 'thesis', 'confidence'],
  properties: {
    action: { type: 'string', enum: ['buy', 'sell', 'hold'] },
    token: { type: ['string', 'null'], description: 'Contract address from allowed_assets; null when action is hold.' },
    size: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'value'],
          properties: {
            type: { type: 'string', enum: ['quote_amount', 'fraction_of_position'] },
            value: { type: 'string', description: 'Decimal string, e.g. "125.5" or "0.25".' },
          },
        },
      ],
    },
    rationale: { type: 'string' },
    thesis: {
      type: 'object',
      additionalProperties: false,
      required: ['claim', 'horizon_ticks', 'invalidated_if'],
      properties: {
        claim: { type: 'string' },
        horizon_ticks: { type: 'integer' },
        invalidated_if: { type: 'string' },
      },
    },
    confidence: { type: 'number' },
  },
} as const;

export type AssetInfo = { address: Address; symbol: string; decimals: number; isStockToken: boolean };

/** Everything the model sees for one tick. Assembled by the runtime according to `context_inputs`. */
export type DecisionContext = {
  agentId: string;
  userId: string;
  configVersion: number;
  /** The user's mandate (strategy, style, rules). */
  mandate: string;
  model: string;
  maxTokens: number;
  mode: 'live' | 'paper';
  quote: AssetInfo;
  assets: AssetInfo[];
  /** Untrusted data: prices, candles, positions, balances, recent decisions. */
  data: Record<string, unknown>;
  snapshotTs: Date | null;
};

export type DecideResult =
  | {
      ok: true;
      decision: Decision;
      model: string;
      promptHash: string;
      responseHash: string;
      tokensUsed: number;
    }
  | {
      ok: false;
      /** budget_exhausted | model_refused | invalid_output | provider_error */
      reason: 'budget_exhausted' | 'model_refused' | 'invalid_output' | 'provider_error';
      message: string;
      model: string;
      promptHash: string;
      responseHash: string;
      tokensUsed: number;
    };

/** One implementation per provider; switching models needs no other code change (architecture §3.5). */
export interface DecisionProvider {
  readonly name: string;
  supports(model: string): boolean;
  complete(req: { system: string; user: string; model: string; maxTokens: number }): Promise<{
    text: string | null;
    stopReason: string | null;
    model: string;
    tokensUsed: number;
  }>;
}
