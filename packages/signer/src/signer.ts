import { encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  EXPORT_MAX_TTL_SECONDS,
  Rejection,
  UNLIMITED_APPROVAL_THRESHOLD,
  decodePath,
  parseExportKeyMessage,
  type ApproveRequest,
  type ExportRequest,
  type WithdrawRequest,
  type DecodedPath,
  type GasParams,
  type SwapRequest,
} from '@odin/shared';
import { MAX_HOPS, type SignerConfig } from './config.ts';
import type { ChainReader } from './chain.ts';
import type { Channel, Ledger } from './ledger.ts';
import type { AgentPolicy, PolicyStore } from './policy.ts';
import { deriveAgentKey } from './keys.ts';

const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const routerAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
]);

/** Guard quota must cover closing every open position (approve + swap) at least 3 times a day. */
export const GUARD_SIGNATURES_PER_POSITION = 2 * 3;

export type SignedIntent = {
  from: Address;
  to: Address;
  txHash: Hex;
  signedTx: Hex;
  nonce: number;
  /** unix seconds; only for swaps */
  deadline?: number;
};

export type SignerDeps = {
  config: Pick<
    SignerConfig,
    'chainId' | 'router' | 'factory' | 'usdg' | 'weth' | 'agentDailyCap' | 'guardDailyCapFloor' | 'deadlineSeconds' | 'maxGasLimit' | 'maxFeePerGas'
  >;
  seed: Uint8Array;
  policies: PolicyStore;
  ledger: Ledger;
  chain: ChainReader;
  now?: () => Date;
};

export class Signer {
  private readonly d: SignerDeps;
  private readonly now: () => Date;

  constructor(deps: SignerDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Refuse to start unless the RPC is the pinned chain and the pinned router uses the pinned factory. */
  async preflight(): Promise<void> {
    const id = await this.d.chain.chainId();
    if (id !== this.d.config.chainId) throw new Rejection('chain_mismatch', `RPC chain ${id} != pinned ${this.d.config.chainId}`);
    const f = await this.d.chain.routerFactory(this.d.config.router);
    if (f !== this.d.config.factory) throw new Rejection('chain_mismatch', `router factory ${f} != pinned factory ${this.d.config.factory}`);
  }

  /** Public address for a derivation index, so the API can record a new agent wallet without the seed. */
  addressFor(derivationIndex: bigint): Address {
    return privateKeyToAccount(deriveAgentKey(this.d.seed, derivationIndex)).address;
  }

  /**
   * Withdraw (architecture §6): ERC-20 transfer or native ETH, ALWAYS to the agent owner's SIWE wallet, read
   * here from the database. Allowed for any agent status (a retired agent's funds must still come back),
   * agent channel only.
   */
  async withdraw(req: WithdrawRequest, channel: Channel): Promise<SignedIntent & { recipient: Address }> {
    if (channel !== 'agent') throw new Rejection('unauthorized', 'withdrawals are not available on this channel');
    const w = await this.d.policies.walletOwner(req.agentId);
    if (!w) throw new Rejection('unknown_agent', 'agent has no derived wallet');
    const amount = BigInt(req.amount);
    if (amount === 0n) throw new Rejection('amount_invalid', 'amount must be > 0');
    if (amount >= UNLIMITED_APPROVAL_THRESHOLD) throw new Rejection('amount_invalid', 'amount is at or above 2^255');
    const signer = { ...w, openLivePositions: 0 };
    const signed =
      req.token === null
        ? await this.signAndRecord(signer, channel, 'withdraw', w.owner, '0x', req.gasParams, amount)
        : await this.signAndRecord(
            signer,
            channel,
            'withdraw',
            getAddress(req.token),
            encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [w.owner, amount] }),
            req.gasParams,
          );
    return { ...signed, recipient: w.owner };
  }

  /**
   * Key export (architecture §6): only with the owner's own wallet signature over the exact export message,
   * verified HERE (EOA or ERC-1271) with a single-use nonce and a short expiry, so the API alone cannot export.
   */
  async exportKey(req: ExportRequest, channel: Channel): Promise<{ address: Address; privateKey: Hex }> {
    if (channel !== 'agent') throw new Rejection('unauthorized', 'key export is not available on this channel');
    const w = await this.d.policies.walletOwner(req.agentId);
    if (!w) throw new Rejection('unknown_agent', 'agent has no derived wallet');
    const m = parseExportKeyMessage(req.message);
    if (!m) throw new Rejection('bad_request', 'not an export message');
    if (m.agentId !== req.agentId || m.wallet !== w.wallet || m.chainId !== this.d.config.chainId) {
      throw new Rejection('unauthorized', 'export message does not match this agent wallet or chain');
    }
    const now = this.now().getTime();
    if (m.expiresAt.getTime() <= now || m.expiresAt.getTime() - now > EXPORT_MAX_TTL_SECONDS * 1000) {
      throw new Rejection('unauthorized', 'export message expired or valid for too long');
    }
    const ok = await this.read(() => this.d.chain.verifyMessage(w.owner, req.message, req.signature as Hex));
    if (!ok) throw new Rejection('unauthorized', 'export message is not signed by the agent owner');
    if (!(await this.d.ledger.burnExportNonce(m.nonce, req.agentId))) throw new Rejection('unauthorized', 'export message already used');
    const privateKey = deriveAgentKey(this.d.seed, w.derivationIndex);
    if (privateKeyToAccount(privateKey).address !== w.wallet) throw new Rejection('internal_error', 'derived key does not match the recorded agent wallet');
    return { address: w.wallet, privateKey };
  }

  async approve(req: ApproveRequest, channel: Channel): Promise<SignedIntent> {
    const policy = await this.policy(req.agentId, channel);
    const amountIn = parseAmount(req.swap.amountIn);
    const path = await this.validateSwap(policy, req.swap.path as Hex, amountIn, channel);
    // spender is always the pinned router; amount is exactly what the pending swap needs
    const token = path.tokens[0]!;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.d.config.router, amountIn] });
    return this.signAndRecord(policy, channel, 'approve', token, data, req.gasParams);
  }

  async swap(req: SwapRequest, channel: Channel): Promise<SignedIntent> {
    const policy = await this.policy(req.agentId, channel);
    const amountIn = parseAmount(req.swap.amountIn);
    const amountOutMin = BigInt(req.amountOutMin);
    if (amountOutMin === 0n) throw new Rejection('min_out_zero', 'amountOutMin must be > 0 (slippage protection)');
    await this.validateSwap(policy, req.swap.path as Hex, amountIn, channel);

    const deadline = Math.floor(this.now().getTime() / 1000) + this.d.config.deadlineSeconds;
    const inner = encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInput',
      args: [{ path: req.swap.path as Hex, recipient: policy.wallet, amountIn, amountOutMinimum: amountOutMin }],
    });
    const data = encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [BigInt(deadline), [inner]] });
    const signed = await this.signAndRecord(policy, channel, 'swap', this.d.config.router, data, req.gasParams);
    return { ...signed, deadline };
  }

  private async policy(agentId: string, channel: Channel): Promise<AgentPolicy> {
    const p = await this.d.policies.load(agentId);
    if (!p) throw new Rejection('unknown_agent', 'agent has no derived wallet or config');
    if (p.status === 'retired') throw new Rejection('agent_retired', 'agent is retired');
    // guards keep protecting paused agents; the agent itself can only act while active
    const allowed = channel === 'guard' ? p.status === 'active' || p.status === 'paused' : p.status === 'active';
    if (!allowed) throw new Rejection('agent_not_active', `agent status ${p.status} cannot sign on ${channel} channel`);
    // base assets are only USDG and ETH (as WETH) on Robinhood Chain
    if (p.quoteAsset !== this.d.config.usdg && p.quoteAsset !== this.d.config.weth) {
      throw new Rejection('quote_not_allowed', 'agent quote asset must be USDG or WETH');
    }
    return p;
  }

  private async validateSwap(p: AgentPolicy, rawPath: Hex, amountIn: bigint, channel: Channel): Promise<DecodedPath> {
    const path = decodePath(rawPath);
    const { tokens, hops } = path;
    if (hops.length < 1 || hops.length > MAX_HOPS) throw new Rejection('invalid_path', `path must have 1-${MAX_HOPS} hops`);
    if (new Set(tokens).size !== tokens.length) throw new Rejection('invalid_path', 'path repeats a token');

    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;
    const endpointAllowed = (t: Address) => p.assets.has(t) || t === p.quoteAsset;
    // An exit of a token the agent still holds is allowed even after the user removed it from the assets
    // (otherwise its TP/SL could never fire): only as a sell straight into the quote asset.
    const heldExit = p.heldTokens.has(first) && last === p.quoteAsset;
    if (!heldExit && (!endpointAllowed(first) || !endpointAllowed(last))) {
      throw new Rejection('token_not_allowed', 'path endpoints must be the agent assets or its quote asset');
    }
    for (const mid of tokens.slice(1, -1)) {
      if (mid !== this.d.config.usdg && mid !== this.d.config.weth) {
        throw new Rejection('intermediate_not_allowed', `intermediate ${mid} is not USDG or WETH`);
      }
    }
    if (channel === 'guard' && (last !== p.quoteAsset || !(p.assets.has(first) || p.heldTokens.has(first)))) {
      throw new Rejection('guard_must_sell_to_quote', 'guard exits must sell an agent asset or held token into the quote asset');
    }
    if (amountIn >= UNLIMITED_APPROVAL_THRESHOLD) throw new Rejection('approval_too_large', 'amount is at or above 2^255');

    for (const h of hops) {
      const pool = await this.read(() => this.d.chain.liquidPool(this.d.config.factory, h.tokenIn, h.tokenOut, h.fee));
      if (!pool) throw new Rejection('no_pool', `no liquid pool for ${h.tokenIn}/${h.tokenOut} fee ${h.fee}`);
    }
    for (const t of tokens) {
      if (!p.stockTokens.has(t)) continue;
      if (await this.read(() => this.d.chain.isPaused(t))) throw new Rejection('token_paused', `stock token ${t} is paused`);
      if (await this.read(() => this.d.chain.isBlocked(t, p.wallet))) throw new Rejection('wallet_blocked', `wallet is blocked by ${t}`);
    }
    return path;
  }

  /** Chain reads fail closed. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Rejection('chain_read_failed', (e as Error).message.split('\n')[0] ?? 'chain read failed');
    }
  }

  private async signAndRecord(
    p: Pick<AgentPolicy, 'agentId' | 'derivationIndex' | 'wallet' | 'openLivePositions'>,
    channel: Channel,
    kind: 'approve' | 'swap' | 'withdraw',
    to: Address,
    data: Hex,
    g: GasParams,
    value = 0n,
  ): Promise<SignedIntent> {
    const gas = BigInt(g.gas);
    const maxFeePerGas = BigInt(g.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(g.maxPriorityFeePerGas);
    if (gas === 0n || gas > this.d.config.maxGasLimit) throw new Rejection('gas_limit_exceeded', `gas ${gas} outside (0, ${this.d.config.maxGasLimit}]`);
    if (maxFeePerGas > this.d.config.maxFeePerGas) throw new Rejection('fee_cap_exceeded', `maxFeePerGas above cap ${this.d.config.maxFeePerGas}`);
    if (maxPriorityFeePerGas > maxFeePerGas) throw new Rejection('fee_cap_exceeded', 'priority fee above max fee');

    const account = privateKeyToAccount(deriveAgentKey(this.d.seed, p.derivationIndex));
    if (account.address !== p.wallet) throw new Rejection('internal_error', 'derived key does not match the recorded agent wallet');

    const signedTx = await account.signTransaction({
      type: 'eip1559',
      chainId: this.d.config.chainId,
      to,
      data,
      value,
      nonce: g.nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const txHash = keccak256(signedTx);
    const cap =
      channel === 'agent'
        ? this.d.config.agentDailyCap
        : Math.max(this.d.config.guardDailyCapFloor, GUARD_SIGNATURES_PER_POSITION * p.openLivePositions);
    // recorded (and cap-checked) before the signature leaves the signer
    await this.d.ledger.record({ agentId: p.agentId, channel, kind, txHash, nonce: g.nonce, cap }, this.now());
    return { from: p.wallet, to, txHash, signedTx, nonce: g.nonce };
  }
}

function parseAmount(raw: string): bigint {
  const v = BigInt(raw);
  if (v === 0n) throw new Rejection('amount_invalid', 'amountIn must be > 0');
  return v;
}
