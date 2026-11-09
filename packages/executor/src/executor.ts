import type { Address, Hex } from 'viem';
import { Rejection, decodePath, type GasParams, type RejectionCode } from '@odin/shared';
import { broadcast } from './broadcast.ts';
import { realizedAmounts } from './logs.ts';
import type { ExecChain, RpcReceipt } from './rpc.ts';
import type { SignerApi, SignedIntent } from './signer-client.ts';
import type { ExecStatus, ExecutionStore } from './store.ts';

export type ExecutorConfig = {
  /** Pinned SwapRouter02 — the spender whose allowance we check. Must equal the signer's. */
  router: Address;
  gas: { approve: bigint; swapBase: bigint; swapPerHop: bigint };
  /** maxFeePerGas = min(baseFee * baseFeeMultiplier + priorityFee, maxFeePerGas) */
  baseFeeMultiplier: bigint;
  priorityFee: bigint;
  maxFeePerGas: bigint;
  /** How long to wait for an approve receipt; swaps wait until their deadline + grace. */
  approveTimeoutMs: number;
  deadlineGraceMs: number;
  pollMs: number;
};

export type SwapJob = {
  decisionId: string;
  agentId: string;
  wallet: Address;
  channel: 'agent' | 'guard';
  path: Hex;
  amountIn: bigint;
  amountOutMin: bigint;
};

export type TxOutcome = {
  kind: 'approve' | 'swap';
  status: ExecStatus | 'rejected';
  txHash?: Hex;
  nonce?: number;
  code?: RejectionCode;
  message?: string;
  block?: bigint;
  gasUsed?: bigint;
};

export type SwapOutcome =
  | { ok: true; approve?: TxOutcome; swap: TxOutcome; amountIn: bigint; amountOut: bigint }
  | { ok: false; approve?: TxOutcome; swap?: TxOutcome; code: RejectionCode; message: string };

export type ExecutorDeps = {
  config: ExecutorConfig;
  chain: ExecChain;
  signer: SignerApi;
  store: ExecutionStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Executor (architecture §3.9): allowance check → (approve) → swap, each signed by the signer,
 * broadcast through the RPC fallback list, and resolved to a final status before returning,
 * so no execution is left holding a nonce.
 */
export class Executor {
  private readonly d: ExecutorDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ExecutorDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async executeSwap(job: SwapJob): Promise<SwapOutcome> {
    const { tokens } = decodePath(job.path);
    const tokenIn = tokens[0]!;
    const tokenOut = tokens[tokens.length - 1]!;
    const swapSpec = { path: job.path, amountIn: job.amountIn.toString() };

    let approve: TxOutcome | undefined;
    const allowance = await this.d.chain.allowance(tokenIn, job.wallet, this.d.config.router);
    if (allowance < job.amountIn) {
      approve = await this.runTx(job, 'approve', this.d.config.gas.approve, (gasParams) =>
        this.d.signer.approve({ agentId: job.agentId, swap: swapSpec, gasParams }),
      );
      if (approve.status !== 'confirmed') {
        return { ok: false, approve, code: approve.code ?? 'approve_failed', message: approve.message ?? `approve ${approve.status}` };
      }
    }

    const hops = BigInt(tokens.length - 1);
    let receipt: RpcReceipt | null = null;
    const swap = await this.runTx(
      job,
      'swap',
      this.d.config.gas.swapBase + this.d.config.gas.swapPerHop * hops,
      (gasParams) => this.d.signer.swap({ agentId: job.agentId, swap: swapSpec, amountOutMin: job.amountOutMin.toString(), gasParams }),
      (r) => {
        receipt = r;
      },
    );
    if (swap.status !== 'confirmed' || !receipt) {
      return { ok: false, approve, swap, code: swap.code ?? 'broadcast_failed', message: swap.message ?? `swap ${swap.status}` };
    }
    const { amountIn, amountOut } = realizedAmounts((receipt as RpcReceipt).logs, job.wallet, tokenIn, tokenOut);
    await this.d.store.update(swap.txHash!, { status: 'confirmed', amountIn, amountOut });
    return { ok: true, approve, swap, amountIn, amountOut };
  }

  private async gasParams(nonce: number, gas: bigint): Promise<GasParams> {
    const base = await this.d.chain.baseFee();
    const c = this.d.config;
    let maxFee = base * c.baseFeeMultiplier + c.priorityFee;
    if (maxFee > c.maxFeePerGas) maxFee = c.maxFeePerGas;
    if (maxFee < c.priorityFee) maxFee = c.priorityFee;
    return { nonce, gas: gas.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: c.priorityFee.toString() };
  }

  private async runTx(
    job: SwapJob,
    kind: 'approve' | 'swap',
    gas: bigint,
    sign: (g: GasParams) => Promise<SignedIntent>,
    onReceipt?: (r: RpcReceipt) => void,
  ): Promise<TxOutcome> {
    const chainPending = await this.d.chain.nonce(job.wallet, 'pending');
    let signed: { txHash: Hex; signedTx: Hex; deadline: Date | null; nonce: number };
    try {
      signed = await this.d.store.withNonce(job.wallet, chainPending, { decisionId: job.decisionId, channel: job.channel, kind }, async (nonce) => {
        const s = await sign(await this.gasParams(nonce, gas));
        if (s.nonce !== nonce) throw new Rejection('internal_error', `signer used nonce ${s.nonce}, expected ${nonce}`);
        return { txHash: s.txHash, signedTx: s.signedTx, deadline: s.deadline ? new Date(s.deadline * 1000) : null };
      });
    } catch (e) {
      if (e instanceof Rejection) return { kind, status: 'rejected', code: e.code, message: e.message };
      throw e;
    }
    const base = { kind, txHash: signed.txHash, nonce: signed.nonce };

    // never broadcast a swap whose deadline already passed (architecture §3.8)
    if (signed.deadline && signed.deadline.getTime() <= this.now()) {
      await this.d.store.update(signed.txHash, { status: 'expired', errorCode: 'tx_expired' });
      return { ...base, status: 'expired', code: 'tx_expired', message: 'deadline passed before broadcast' };
    }

    const b = await broadcast(this.d.chain.endpoints, signed.signedTx);
    if (!b.ok) {
      await this.d.store.update(signed.txHash, { status: 'dropped', rpc: b.rpc, errorCode: b.code, error: b.error });
      return { ...base, status: 'dropped', code: b.code, message: b.error };
    }
    await this.d.store.update(signed.txHash, { status: 'broadcast', rpc: b.rpc });

    const waitUntil = signed.deadline ? signed.deadline.getTime() + this.d.config.deadlineGraceMs : this.now() + this.d.config.approveTimeoutMs;
    for (;;) {
      const r = await this.d.chain.receipt(signed.txHash).catch(() => null);
      if (r) {
        const status: ExecStatus = r.status === 'success' ? 'confirmed' : 'reverted';
        await this.d.store.update(signed.txHash, { status, block: r.blockNumber, gasUsed: r.gasUsed });
        onReceipt?.(r);
        return status === 'confirmed'
          ? { ...base, status, block: r.blockNumber, gasUsed: r.gasUsed }
          : { ...base, status, block: r.blockNumber, gasUsed: r.gasUsed, code: 'tx_reverted', message: 'transaction reverted' };
      }
      if (this.now() >= waitUntil) {
        // a swap past its deadline can only revert if it is ever mined; the watchdog reconciles either way
        const status: ExecStatus = signed.deadline ? 'expired' : 'dropped';
        const code: RejectionCode = signed.deadline ? 'tx_expired' : 'tx_timeout';
        await this.d.store.update(signed.txHash, { status, errorCode: code, error: 'no receipt before timeout' });
        return { ...base, status, code, message: 'no receipt before timeout' };
      }
      await this.sleep(this.d.config.pollMs);
    }
  }
}
