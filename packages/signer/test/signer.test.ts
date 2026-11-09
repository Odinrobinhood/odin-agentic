import { describe, expect, it, beforeEach } from 'vitest';
import { decodeFunctionData, getAddress, parseAbi, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApproveRequest, Rejection, SwapRequest, encodePath, type GasParams } from '@odin/shared';
import { Signer, type SignerDeps } from '../src/signer.ts';
import { MemoryLedger } from '../src/ledger.ts';
import { deriveAgentKey } from '../src/keys.ts';
import type { ChainReader } from '../src/chain.ts';
import type { AgentPolicy, PolicyStore } from '../src/policy.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const ROUTER = addr(0x1001);
const FACTORY = addr(0x1002);
const USDG = addr(0x2001);
const WETH = addr(0x2002);
const TSLA = addr(0x3001); // stock token
const MEME = addr(0x3002);
const OTHER = addr(0x3003); // not an agent asset
const ATTACKER = addr(0xbad);
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const SEED = new Uint8Array(32).fill(7);
const WALLET = privateKeyToAccount(deriveAgentKey(SEED, 5n)).address;
const NOW = new Date('2026-11-09T12:00:00Z');

const routerAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
]);
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

class FakeChain implements ChainReader {
  pools = new Set<string>();
  paused = new Set<Address>();
  blocked = new Set<Address>();
  failReads = false;
  key(x: Address, y: Address, fee: number) {
    return [x, y].sort().join('-') + `-${fee}`;
  }
  addPool(x: Address, y: Address, fee: number) {
    this.pools.add(this.key(x, y, fee));
  }
  async chainId() {
    return 46630;
  }
  async routerFactory() {
    return FACTORY;
  }
  async liquidPool(_f: Address, x: Address, y: Address, fee: number) {
    if (this.failReads) throw new Error('rpc down');
    return this.pools.has(this.key(x, y, fee)) ? addr(0x9999) : null;
  }
  async isPaused(t: Address) {
    return this.paused.has(t);
  }
  async isBlocked(t: Address) {
    return this.blocked.has(t);
  }
}

class StaticPolicies implements PolicyStore {
  policy: AgentPolicy | null;
  constructor(p: AgentPolicy | null) {
    this.policy = p;
  }
  async load(id: string) {
    return this.policy && this.policy.agentId === id ? this.policy : null;
  }
}

const gas: GasParams = { nonce: 3, gas: '500000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '0' };

function makePolicy(over: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    agentId: AGENT_ID,
    status: 'active',
    derivationIndex: 5n,
    wallet: WALLET,
    quoteAsset: USDG,
    assets: new Set([TSLA, MEME]),
    stockTokens: new Set([TSLA]),
    heldTokens: new Set(),
    openLivePositions: 0,
    ...over,
  };
}

let chain: FakeChain;
let policies: StaticPolicies;
let ledger: MemoryLedger;
let signer: Signer;

function build(over: Partial<SignerDeps['config']> = {}) {
  signer = new Signer({
    config: {
      chainId: 46630,
      router: ROUTER,
      factory: FACTORY,
      usdg: USDG,
      weth: WETH,
      agentDailyCap: 10,
      guardDailyCapFloor: 4,
      deadlineSeconds: 60,
      maxGasLimit: 5_000_000n,
      maxFeePerGas: 1_000_000_000n,
      ...over,
    },
    seed: SEED,
    policies,
    ledger,
    chain,
    now: () => NOW,
  });
}

beforeEach(() => {
  chain = new FakeChain();
  chain.addPool(USDG, TSLA, 500);
  chain.addPool(USDG, WETH, 500);
  chain.addPool(WETH, MEME, 3000);
  chain.addPool(OTHER, USDG, 500);
  policies = new StaticPolicies(makePolicy());
  ledger = new MemoryLedger();
  build();
});

const buyTsla = encodePath([USDG, TSLA], [500]);
const sellTsla = encodePath([TSLA, USDG], [500]);
const swapReq = (path: Hex, over: Partial<SwapRequest> = {}): SwapRequest => ({
  agentId: AGENT_ID,
  swap: { path, amountIn: '1000000' },
  amountOutMin: '1',
  gasParams: gas,
  ...over,
});

async function rejects(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof Rejection && e.code === code);
}

describe('swap', () => {
  it('signs a swap to the pinned router, paying the agent wallet, with a signer-set deadline', async () => {
    const out = await signer.swap(swapReq(buyTsla), 'agent');
    const tx = parseTransaction(out.signedTx);
    expect(tx.chainId).toBe(46630);
    expect(tx.to).toBe(ROUTER);
    expect(tx.value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: out.signedTx as never })).toBe(WALLET);

    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data! });
    expect(outer.functionName).toBe('multicall');
    const [deadline, calls] = outer.args as [bigint, Hex[]];
    expect(deadline).toBe(BigInt(Math.floor(NOW.getTime() / 1000) + 60));
    expect(out.deadline).toBe(Number(deadline));
    expect(calls).toHaveLength(1);
    const inner = decodeFunctionData({ abi: routerAbi, data: calls[0]! });
    expect(inner.functionName).toBe('exactInput');
    const p = (inner.args as [{ recipient: Address; amountIn: bigint; amountOutMinimum: bigint; path: Hex }])[0];
    expect(p.recipient).toBe(WALLET);
    expect(p.amountIn).toBe(1000000n);
    expect(p.amountOutMinimum).toBe(1n);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.txHash).toBe(out.txHash);
  });

  it('re-signing a byte-identical approve is idempotent', async () => {
    const r = { agentId: AGENT_ID, swap: { path: sellTsla, amountIn: '5' }, gasParams: gas };
    const one = await signer.approve(r, 'agent');
    const two = await signer.approve(r, 'agent');
    expect(two.txHash).toBe(one.txHash);
    expect(ledger.rows).toHaveLength(1);
  });

  it('allows multi-hop through WETH', async () => {
    await expect(signer.swap(swapReq(encodePath([USDG, WETH, MEME], [500, 3000])), 'agent')).resolves.toBeTruthy();
  });

  it('rejects a token the agent does not hold in its assets', async () => {
    await rejects(signer.swap(swapReq(encodePath([USDG, OTHER], [500])), 'agent'), 'token_not_allowed');
  });

  it('rejects an intermediate hop that is not USDG/WETH', async () => {
    chain.addPool(TSLA, OTHER, 500);
    chain.addPool(OTHER, MEME, 500);
    await rejects(signer.swap(swapReq(encodePath([TSLA, OTHER, MEME], [500, 500])), 'agent'), 'intermediate_not_allowed');
  });

  it('rejects more than 3 hops and repeated tokens', async () => {
    await rejects(signer.swap(swapReq(encodePath([USDG, WETH, USDG, WETH, MEME], [500, 500, 500, 3000])), 'agent'), 'invalid_path');
    await rejects(signer.swap(swapReq(encodePath([USDG, WETH, USDG], [500, 500])), 'agent'), 'invalid_path');
  });

  it('rejects an invalid fee tier and malformed path bytes', async () => {
    const bad = (buyTsla.slice(0, 42) + '0001f5' + buyTsla.slice(48)) as Hex; // fee 501
    await rejects(signer.swap(swapReq(bad), 'agent'), 'bad_fee_tier');
    await rejects(signer.swap(swapReq((buyTsla + 'ab') as Hex), 'agent'), 'invalid_path');
  });

  it('rejects when the pinned factory has no liquid pool for a hop', async () => {
    await rejects(signer.swap(swapReq(encodePath([USDG, TSLA], [3000])), 'agent'), 'no_pool');
  });

  it('checks paused() and isBlocked() of stock tokens on every signature', async () => {
    chain.paused.add(TSLA);
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'token_paused');
    chain.paused.clear();
    chain.blocked.add(TSLA);
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'wallet_blocked');
  });

  it('fails closed when chain reads fail', async () => {
    chain.failReads = true;
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'chain_read_failed');
  });

  it('requires a non-zero amountOutMin and amountIn', async () => {
    await rejects(signer.swap(swapReq(buyTsla, { amountOutMin: '0' }), 'agent'), 'min_out_zero');
    await rejects(signer.swap(swapReq(buyTsla, { swap: { path: buyTsla, amountIn: '0' } }), 'agent'), 'amount_invalid');
  });

  it('enforces gas and fee caps', async () => {
    await rejects(signer.swap(swapReq(buyTsla, { gasParams: { ...gas, gas: '9000000' } }), 'agent'), 'gas_limit_exceeded');
    await rejects(signer.swap(swapReq(buyTsla, { gasParams: { ...gas, maxFeePerGas: '2000000000' } }), 'agent'), 'fee_cap_exceeded');
  });

  it('refuses when the derived key does not match the recorded wallet', async () => {
    policies.policy = makePolicy({ wallet: ATTACKER });
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'internal_error');
  });
});

describe('approve', () => {
  it('approves only the pinned router, for exactly the swap amount, on the sold token', async () => {
    const out = await signer.approve({ agentId: AGENT_ID, swap: { path: sellTsla, amountIn: '777' }, gasParams: gas }, 'agent');
    const tx = parseTransaction(out.signedTx);
    expect(tx.to).toBe(TSLA);
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(d.args).toEqual([ROUTER, 777n]);
  });

  it('rejects approvals at or above 2^255', async () => {
    const huge = (2n ** 255n).toString();
    await rejects(signer.approve({ agentId: AGENT_ID, swap: { path: sellTsla, amountIn: huge }, gasParams: gas }, 'agent'), 'approval_too_large');
  });

  it('request schemas have no spender / recipient / deadline fields and reject extras', () => {
    expect(ApproveRequest.safeParse({ agentId: AGENT_ID, swap: { path: sellTsla, amountIn: '1' }, gasParams: gas, spender: ATTACKER }).success).toBe(false);
    expect(SwapRequest.safeParse({ ...swapReq(buyTsla), recipient: ATTACKER }).success).toBe(false);
    expect(SwapRequest.safeParse({ ...swapReq(buyTsla), deadline: 9999999999 }).success).toBe(false);
  });
});

describe('agent status and channels', () => {
  it('rejects unknown and retired agents on every channel', async () => {
    policies.policy = makePolicy({ status: 'retired' });
    await rejects(signer.swap(swapReq(sellTsla), 'guard'), 'agent_retired');
    policies.policy = null;
    await rejects(signer.swap(swapReq(sellTsla), 'agent'), 'unknown_agent');
  });

  it('only USDG or WETH may be an agent quote asset, on every channel', async () => {
    policies.policy = makePolicy({ quoteAsset: MEME, assets: new Set([TSLA]) });
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'quote_not_allowed');
    await rejects(signer.swap(swapReq(sellTsla), 'guard'), 'quote_not_allowed');
    policies.policy = makePolicy({ quoteAsset: WETH, assets: new Set([MEME]) });
    await expect(signer.swap(swapReq(encodePath([WETH, MEME], [3000])), 'agent')).resolves.toBeTruthy();
  });

  it('a held token removed from the assets can still be exited into the quote asset, and nothing else', async () => {
    chain.addPool(OTHER, WETH, 500);
    policies.policy = makePolicy({ heldTokens: new Set([OTHER]), stockTokens: new Set([TSLA, OTHER]) });
    const exit = encodePath([OTHER, USDG], [500]);
    await expect(signer.swap(swapReq(exit), 'guard')).resolves.toBeTruthy();
    await expect(signer.swap(swapReq(exit, { gasParams: { ...gas, nonce: 9 } }), 'agent')).resolves.toBeTruthy();
    // buying it back, or selling it into something other than the quote asset, is still refused
    await rejects(signer.swap(swapReq(encodePath([USDG, OTHER], [500])), 'agent'), 'token_not_allowed');
    await rejects(signer.swap(swapReq(encodePath([OTHER, WETH], [500])), 'agent'), 'token_not_allowed');
    // held stock tokens keep their paused()/isBlocked() checks
    chain.paused.add(OTHER);
    await rejects(signer.swap(swapReq(exit, { gasParams: { ...gas, nonce: 10 } }), 'guard'), 'token_paused');
  });

  it('a paused agent cannot trade, but its guards can still exit', async () => {
    policies.policy = makePolicy({ status: 'paused' });
    await rejects(signer.swap(swapReq(buyTsla), 'agent'), 'agent_not_active');
    await expect(signer.swap(swapReq(sellTsla), 'guard')).resolves.toBeTruthy();
  });

  it('guard exits must sell an asset into the quote asset', async () => {
    await rejects(signer.swap(swapReq(buyTsla), 'guard'), 'guard_must_sell_to_quote');
  });

  it('an agent that exhausted its cap can still be exited through the guard quota', async () => {
    build({ agentDailyCap: 2 });
    await signer.swap(swapReq(buyTsla, { gasParams: { ...gas, nonce: 1 } }), 'agent');
    await signer.swap(swapReq(buyTsla, { gasParams: { ...gas, nonce: 2 } }), 'agent');
    await rejects(signer.swap(swapReq(buyTsla, { gasParams: { ...gas, nonce: 3 } }), 'agent'), 'signature_cap_reached');
    await expect(signer.swap(swapReq(sellTsla, { gasParams: { ...gas, nonce: 3 } }), 'guard')).resolves.toBeTruthy();
  });

  it('guard quota scales with open positions (3 full exits per position)', async () => {
    policies.policy = makePolicy({ openLivePositions: 2 }); // max(4, 6*2) = 12
    for (let n = 0; n < 12; n++) await signer.swap(swapReq(sellTsla, { gasParams: { ...gas, nonce: n } }), 'guard');
    await rejects(signer.swap(swapReq(sellTsla, { gasParams: { ...gas, nonce: 12 } }), 'guard'), 'signature_cap_reached');
  });
});

describe('preflight', () => {
  it('refuses a mismatched chain or router factory', async () => {
    build({ chainId: 4663 });
    await rejects(signer.preflight(), 'chain_mismatch');
    build({ factory: ATTACKER });
    await rejects(signer.preflight(), 'chain_mismatch');
    build();
    await expect(signer.preflight()).resolves.toBeUndefined();
  });
});
