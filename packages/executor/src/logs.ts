import { getAddress, type Address } from 'viem';
import type { RpcLog } from './rpc.ts';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddress(t: string | undefined): Address | null {
  return t && t.length === 66 ? getAddress(`0x${t.slice(26)}`) : null;
}

/**
 * Realized amounts from ERC-20 Transfer logs, not from the quote, so fee-on-transfer and rebasing
 * tokens are recorded as they actually moved (architecture §7).
 */
export function realizedAmounts(logs: RpcLog[], wallet: Address, tokenIn: Address, tokenOut: Address): { amountIn: bigint; amountOut: bigint } {
  let amountIn = 0n;
  let amountOut = 0n;
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const value = BigInt(l.data === '0x' ? 0 : l.data);
    if (l.address === tokenIn && from === wallet) amountIn += value;
    if (l.address === tokenOut && to === wallet) amountOut += value;
  }
  return { amountIn, amountOut };
}
