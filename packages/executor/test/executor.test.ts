import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { Rejection, encodePath, type ApproveRequest, type SwapRequest } from '@odin/shared';
import { Executor, type ExecutorConfig } from '../src/executor.ts';
import { MemoryExecutionStore, nextNonce } from '../src/store.ts';
import { RpcError, type ExecChain, type RpcEndpoint, type RpcLog, type RpcReceipt } from '../src/rpc.ts';
import { TRANSFER_TOPIC, realizedAmounts } from '../src/logs.ts';
import { broadcast } from '../src/broadcast.ts';
import { checkNonce, reconcileInflight } from '../src/watchdog.ts';
import type { SignerApi, SignedIntent } from '../src/signer-client.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const ROUTER = addr(0x1001);
const USDG = addr(0x2001);
const TSLA = addr(0x3001);
const POOL = addr(0x9001);
const WALLET = addr(0xa11ce);
const AGENT = '11111111-1111-4111-8111-111111111111';
const DECISION = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-11-09T12:00:00Z');

const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
const transfer = (token: Address, from: Address, to: Address, value: bigint, logIndex = 0): RpcLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: toHex(value, { size: 32 }),
  logIndex,
});

class Endpoint implements RpcEndpoint {
  url: string;
  sendError: string | null = null;
  sent: Hex[] = [];
  constructor(url: string) {
    this.url = url;
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (method !== 'eth_sendRawTransaction') throw new Error('unexpected');
    if (this.sendError) throw new RpcError(this.url, this.sendError);
    this.sent.push(params[0] as Hex);
    return '0x' as T;
  }
}

class FakeChain implements ExecChain {
  endpoints: Endpoint[] = [new Endpoint('rpc-a'), new Endpoint('rpc-b')];
  pending = 7;
  latest = 7;
  allow = 0n;
  receipts = new Map<Hex, RpcReceipt>();
  /** receipt factory: called once a tx is broadcast */
  onBroadcast: (hash: Hex) => RpcReceipt | null = () => null;
  async chainId() {
    return 4663;
  }
  async nonce(_a: Address, tag: 'latest' | 'pending') {
    return tag === 'pending' ? this.pending : this.latest;
  }
  async baseFee() {
    return 10_000_000n;
  }
  async allowance() {
    return this.allow;
  }
  async receipt(hash: Hex) {
    if (!this.receipts.has(hash) && this.endpoints.some((e) => e.sent.length)) {
      const r = this.onBroadcast(hash);
      if (r) this.receipts.set(hash, r);
    }
    return this.receipts.get(hash) ?? null;
  }
}

class FakeSigner implements SignerApi {
  calls: { kind: string; req: ApproveRequest | SwapRequest }[] = [];
  reject: Rejection | null = null;
  deadline = Math.floor(T0 / 1000) + 60;
  private sign(kind: string, req: ApproveRequest | SwapRequest): SignedIntent {
    if (this.reject) throw this.reject;
    this.calls.push({ kind, req });
    const signedTx = toHex(`${kind}:${JSON.stringify(req)}`);
    return { from: WALLET, to: kind === 'approve' ? USDG : ROUTER, signedTx, txHash: keccak256(signedTx), nonce: req.gasParams.nonce, ...(kind === 'swap' ? { deadline: this.deadline } : {}) };
  }
  async approve(req: ApproveRequest) {
    return this.sign('approve', req);
  }
  async swap(req: SwapRequest) {
    return this.sign('swap', req);
  }
}

const config: ExecutorConfig = {
  router: ROUTER,
  gas: { approve: 300_000n, swapBase: 600_000n, swapPerHop: 400_000n },
  baseFeeMultiplier: 2n,
  priorityFee: 0n,
  maxFeePerGas: 1_000_000_000n,
  approveTimeoutMs: 5_000,
  deadlineGraceMs: 1_000,
  pollMs: 250,
};

let chain: FakeChain;
let signer: FakeSigner;
let store: MemoryExecutionStore;
let clock: number;
let executor: Executor;

const ok = (hash: Hex, logs: RpcLog[] = []): RpcReceipt => ({ transactionHash: hash, status: 'success', blockNumber: 100n, gasUsed: 150_000n, effectiveGasPrice: 1n, logs });
const job = (over = {}) => ({
  decisionId: DECISION,
  agentId: AGENT,
  wallet: WALLET,
  channel: 'agent' as const,
  path: encodePath([USDG, TSLA], [500]),
  amountIn: 1_000_000n,
  amountOutMin: 900n,
  ...over,
});

beforeEach(() => {
  chain = new FakeChain();
  signer = new FakeSigner();
  store = new MemoryExecutionStore();
  clock = T0;
  executor = new Executor({ config, chain, signer, store, now: () => clock, sleep: async (ms) => void (clock += ms) });
});

describe('executeSwap', () => {
  it('approves when allowance is short, then swaps and records realized amounts from Transfer logs', async () => {
    chain.onBroadcast = (h) =>
      ok(h, [
        transfer(USDG, WALLET, POOL, 1_000_000n, 1),
        transfer(TSLA, POOL, WALLET, 950n, 2),
        transfer(TSLA, POOL, addr(0xfee), 5n, 3), // fee-on-transfer skim: not ours
      ]);
    const out = await executor.executeSwap(job());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.approve?.status).toBe('confirmed');
    expect(out.swap.status).toBe('confirmed');
    expect(out.amountIn).toBe(1_000_000n);
    expect(out.amountOut).toBe(950n);
    expect(signer.calls.map((c) => c.kind)).toEqual(['approve', 'swap']);
    // approve uses chain pending nonce; swap gets the next one even though chain pending has not moved
    expect(signer.calls.map((c) => c.req.gasParams.nonce)).toEqual([7, 8]);
    // gas: base 600k + 400k per hop; fee = baseFee*2 capped
    expect(signer.calls[1]!.req.gasParams).toMatchObject({ gas: '1000000', maxFeePerGas: '20000000', maxPriorityFeePerGas: '0' });
    expect(store.rows.map((r) => [r.kind, r.status])).toEqual([['approve', 'confirmed'], ['swap', 'confirmed']]);
  });

  it('skips approve when allowance already covers amountIn', async () => {
    chain.allow = 10n ** 18n;
    chain.onBroadcast = (h) => ok(h);
    const out = await executor.executeSwap(job());
    expect(out.ok).toBe(true);
    expect(signer.calls.map((c) => c.kind)).toEqual(['swap']);
  });

  it('a signer rejection consumes no nonce and records nothing', async () => {
    chain.allow = 10n ** 18n;
    signer.reject = new Rejection('token_paused', 'paused');
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'token_paused' });
    expect(store.rows).toHaveLength(0);
    signer.reject = null;
    chain.onBroadcast = (h) => ok(h);
    await executor.executeSwap(job());
    expect(signer.calls[0]!.req.gasParams.nonce).toBe(7);
  });

  it('falls back to the next RPC when the first fails, and treats "already known" as accepted', async () => {
    chain.allow = 10n ** 18n;
    chain.onBroadcast = (h) => ok(h);
    chain.endpoints[0]!.sendError = 'transport: connect ECONNREFUSED';
    const out = await executor.executeSwap(job());
    expect(out.ok).toBe(true);
    expect(store.rows[0]!.rpc).toBe('rpc-b');

    const r = await broadcast([Object.assign(new Endpoint('x'), { sendError: 'already known' })], '0x01');
    expect(r).toEqual({ ok: true, rpc: 'x', alreadyKnown: true });
  });

  it('marks a tx dropped (and frees its nonce) when every RPC refuses it', async () => {
    chain.allow = 10n ** 18n;
    for (const e of chain.endpoints) e.sendError = 'insufficient funds for gas * price + value';
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'insufficient_gas' });
    expect(store.rows[0]!.status).toBe('dropped');
    // the dropped tx does not hold nonce 7
    for (const e of chain.endpoints) e.sendError = null;
    chain.onBroadcast = (h) => ok(h);
    await executor.executeSwap(job());
    expect(signer.calls.at(-1)!.req.gasParams.nonce).toBe(7);
  });

  it('never broadcasts a swap whose deadline has passed', async () => {
    chain.allow = 10n ** 18n;
    signer.deadline = Math.floor(T0 / 1000) - 1;
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'tx_expired' });
    expect(chain.endpoints.every((e) => e.sent.length === 0)).toBe(true);
    expect(store.rows[0]!.status).toBe('expired');
  });

  it('expires a swap with no receipt by deadline + grace', async () => {
    chain.allow = 10n ** 18n;
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'tx_expired' });
    expect(clock).toBeGreaterThanOrEqual(T0 + 61_000);
  });

  it('reports a reverted swap', async () => {
    chain.allow = 10n ** 18n;
    chain.onBroadcast = (h) => ({ ...ok(h), status: 'reverted' });
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'tx_reverted' });
    expect(store.rows[0]!.status).toBe('reverted');
  });

  it('stops after a failed approve without signing the swap', async () => {
    chain.onBroadcast = (h) => ({ ...ok(h), status: 'reverted' });
    const out = await executor.executeSwap(job());
    expect(out).toMatchObject({ ok: false, code: 'tx_reverted' });
    expect(signer.calls.map((c) => c.kind)).toEqual(['approve']);
  });
});

describe('nonces', () => {
  it('next nonce = max(chain pending, highest in-flight + 1)', () => {
    expect(nextNonce(5, null)).toBe(5);
    expect(nextNonce(5, 5)).toBe(6);
    expect(nextNonce(9, 6)).toBe(9);
  });

  it('serialises concurrent reservations for one wallet (agent + guard at once)', async () => {
    const sign = (n: number) => async () => ({ txHash: keccak256(toHex(`t${n}`)), deadline: null });
    const got = await Promise.all([0, 1, 2].map((i) => store.withNonce(WALLET, 3, { decisionId: DECISION, channel: 'agent', kind: 'swap' }, sign(i))));
    expect(got.map((g) => g.nonce).sort()).toEqual([3, 4, 5]);
  });
});

describe('watchdog', () => {
  it('detects nonce drift and reconciles stale in-flight executions', async () => {
    const mk = (n: number) => store.withNonce(WALLET, n, { decisionId: DECISION, channel: 'agent', kind: 'swap' }, async () => ({ txHash: keccak256(toHex(`w${n}`)), deadline: new Date(T0 - 1) }));
    const a = await mk(0);
    const b = await mk(1);
    await store.update(a.txHash, { status: 'broadcast' });
    await store.update(b.txHash, { status: 'broadcast' });
    for (const r of store.rows) r.createdAt = new Date(T0 - 120_000);
    chain.receipts.set(a.txHash, ok(a.txHash));
    chain.latest = 1;

    const res = await reconcileInflight(chain, store, { olderThanMs: 60_000, now: T0 });
    expect(res).toEqual({ resolved: 2, pending: 0 });
    expect(store.rows.map((r) => r.status)).toEqual(['confirmed', 'expired']);
    expect(await checkNonce(chain, store, WALLET)).toMatchObject({ chainNonce: 1, recorded: 1, drift: 0 });
    chain.latest = 3;
    expect((await checkNonce(chain, store, WALLET)).drift).toBe(2);
  });
});

describe('realizedAmounts', () => {
  it('ignores transfers of other tokens and other parties', () => {
    const logs = [transfer(USDG, addr(1), POOL, 5n), transfer(TSLA, POOL, addr(2), 5n), transfer(USDG, WALLET, POOL, 7n)];
    expect(realizedAmounts(logs, WALLET, USDG, TSLA)).toEqual({ amountIn: 7n, amountOut: 0n });
  });
});
