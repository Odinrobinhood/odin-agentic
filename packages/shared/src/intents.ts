import { z } from 'zod';
import { isAddress, isHex } from 'viem';

const uintString = z.string().regex(/^[0-9]+$/, 'must be a base-10 unsigned integer string');
const hex = z.string().refine((v) => isHex(v), 'must be hex');

export const GasParams = z.object({
  nonce: z.number().int().nonnegative(),
  gas: uintString,
  maxFeePerGas: uintString,
  maxPriorityFeePerGas: uintString,
});

export const SwapSpec = z.object({
  path: hex,
  amountIn: uintString,
});

/** Approve the pinned router for exactly the amount a pending swap needs. No spender field exists. */
export const ApproveRequest = z.object({
  agentId: z.string().uuid(),
  swap: SwapSpec,
  gasParams: GasParams,
}).strict();

/** Swap exact-in to the agent's own wallet. No recipient or deadline field exists. */
export const SwapRequest = z.object({
  agentId: z.string().uuid(),
  swap: SwapSpec,
  amountOutMin: uintString,
  gasParams: GasParams,
}).strict();

export type ApproveRequest = z.infer<typeof ApproveRequest>;
export type SwapRequest = z.infer<typeof SwapRequest>;
export type GasParams = z.infer<typeof GasParams>;

export const addressSchema = z.string().refine((v) => isAddress(v), 'must be an address');
