import type { Address } from 'viem';
import type { ExecChain } from './rpc.ts';
import type { ExecutionStore } from './store.ts';

export type NonceReport = { wallet: Address; chainNonce: number; recorded: number; drift: number };

/**
 * Nonce watchdog (architecture §3.9, §8): the on-chain nonce must equal the number of our executions
 * that consumed a nonce. Drift means a transaction we did not record (e.g. after a key export) or one
 * we lost track of; the operator is alerted.
 */
export async function checkNonce(chain: ExecChain, store: ExecutionStore, wallet: Address): Promise<NonceReport> {
  const [chainNonce, recorded] = await Promise.all([chain.nonce(wallet, 'latest'), store.consumedCount(wallet)]);
  return { wallet, chainNonce, recorded, drift: chainNonce - recorded };
}

/**
 * Resolve executions still marked signed/broadcast (e.g. after a crash): take the receipt if one exists,
 * otherwise mark them expired/dropped once they can no longer land usefully.
 */
export async function reconcileInflight(
  chain: ExecChain,
  store: ExecutionStore,
  opts: { olderThanMs: number; now?: number },
): Promise<{ resolved: number; pending: number }> {
  const now = opts.now ?? Date.now();
  const rows = await store.inflight(new Date(now - opts.olderThanMs));
  let resolved = 0;
  for (const row of rows) {
    const r = await chain.receipt(row.txHash).catch(() => null);
    if (r) {
      await store.update(row.txHash, { status: r.status === 'success' ? 'confirmed' : 'reverted', block: r.blockNumber, gasUsed: r.gasUsed });
      resolved++;
      continue;
    }
    const pendingNonce = await chain.nonce(row.wallet, 'latest');
    const pastDeadline = row.deadline !== null && row.deadline.getTime() < now;
    if (pendingNonce > row.nonce) {
      // nonce consumed by some other tx: ours can never land
      await store.update(row.txHash, { status: 'dropped', errorCode: 'nonce_conflict', error: 'nonce consumed by another transaction' });
      resolved++;
    } else if (pastDeadline || row.deadline === null) {
      await store.update(row.txHash, {
        status: pastDeadline ? 'expired' : 'dropped',
        errorCode: pastDeadline ? 'tx_expired' : 'tx_timeout',
        error: 'no receipt during reconciliation',
      });
      resolved++;
    }
  }
  return { resolved, pending: rows.length - resolved };
}
