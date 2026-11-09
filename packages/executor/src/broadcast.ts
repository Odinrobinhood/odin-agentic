import type { Hex } from 'viem';
import type { RejectionCode } from '@odin/shared';
import { RpcError, type RpcEndpoint } from './rpc.ts';

export type BroadcastResult =
  | { ok: true; rpc: string; alreadyKnown: boolean }
  | { ok: false; code: RejectionCode; error: string; rpc?: string };

const ALREADY_KNOWN = /already known|known transaction|already exists|already imported|ALREADY_EXISTS/i;
const NONCE_LOW = /nonce too low|nonce has already been used|invalid nonce/i;
const NO_FUNDS = /insufficient funds/i;

/**
 * Send a signed transaction through the ordered RPC list (architecture §3.9).
 * Terminal node answers (insufficient funds, nonce too low) stop the loop: another RPC would say the same.
 * Transport errors and other failures fall through to the next endpoint.
 */
export async function broadcast(endpoints: RpcEndpoint[], signedTx: Hex): Promise<BroadcastResult> {
  let last: { error: string; rpc?: string } = { error: 'no endpoints' };
  for (const ep of endpoints) {
    try {
      await ep.call<Hex>('eth_sendRawTransaction', [signedTx]);
      return { ok: true, rpc: ep.url, alreadyKnown: false };
    } catch (e) {
      const msg = e instanceof RpcError ? e.message : String(e);
      if (ALREADY_KNOWN.test(msg)) return { ok: true, rpc: ep.url, alreadyKnown: true };
      if (NO_FUNDS.test(msg)) return { ok: false, code: 'insufficient_gas', error: msg, rpc: ep.url };
      if (NONCE_LOW.test(msg)) return { ok: false, code: 'nonce_conflict', error: msg, rpc: ep.url };
      last = { error: msg, rpc: ep.url };
    }
  }
  return { ok: false, code: 'broadcast_failed', ...last };
}
