import { parseUnits, type Address, type Hex } from 'viem';
import { Rejection, decodePath, reversePath, type RejectionCode } from '@odin/shared';
import type { BalanceReader, RiskChain, RiskStore } from './ports.ts';
import type { AgentRiskContext, Mode, RiskApproved, RiskIntent, RiskRejected, RiskResult } from './types.ts';

export type RiskConfig = {
  /** Pinned base assets: an agent quote asset must be one of these (USDG or WETH). */
  usdg: Address;
  weth: Address;
  /** Native ETH that must remain for gas in live mode. */
  gasReserveWei: bigint;
  /** Used when the user has not set max_slippage_bps. */
  defaultSlippageBps: number;
  /** Check 5: max |pool − referee| / referee, in bps. */
  priceToleranceBps: number;
};

export const DEFAULT_RISK_CONFIG: Omit<RiskConfig, 'gasReserveWei' | 'usdg' | 'weth'> = {
  defaultSlippageBps: 100,
  priceToleranceBps: 300,
};

const MAX_HOPS = 3;
const BPS = 10_000n;
const FRACTION_DECIMALS = 18;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export type RiskEngineDeps = {
  config: RiskConfig;
  store: RiskStore;
  chain: RiskChain;
  balances: Record<Mode, BalanceReader>;
  now?: () => Date;
};

type Check = RiskRejected['check'];

class CheckFailed extends Rejection {
  readonly check: Check;
  constructor(check: Check, code: RejectionCode, message: string) {
    super(code, message);
    this.check = check;
  }
}

/**
 * Pre-trade Risk Engine (architecture §3.7). Every intent that reaches the Signer passes through here,
 * whether it comes from the agent, a guard (SL/TP) or the user's "close all positions".
 *
 * Checks, in order:
 *   1. token is an agent asset with a route; Stock Tokens not paused, wallet not blocked
 *   2. size ≤ available balance; live mode keeps a native gas reserve
 *   3. user-enabled limits (agent origin only): position, exposure, trades/day, daily loss
 *   4. user max slippage → amountOutMin
 *   5. pool price vs referee (guards may override after the user's deviation timeout)
 */
export class RiskEngine {
  private readonly d: RiskEngineDeps;
  private readonly now: () => Date;

  constructor(deps: RiskEngineDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async evaluate(intent: RiskIntent): Promise<RiskResult> {
    let check: Check = 0;
    try {
      const ctx = await this.agentState(intent);

      // ── 1. token, route, Stock Token status ──────────────────────────────
      check = 1;
      const { sellRoute, path, tokenIn, tokenOut } = await this.routeFor(ctx, intent);

      // ── 2. size vs balance ───────────────────────────────────────────────
      check = 2;
      const balances = this.d.balances[intent.mode];
      const rates = new RateCache(this.d.chain);
      const amountIn = await this.amountIn(ctx, intent, balances, tokenIn, sellRoute, rates);
      if (intent.mode === 'live') {
        const native = await balances.native(ctx);
        if (native < this.d.config.gasReserveWei) {
          throw new CheckFailed(2, 'insufficient_gas', `wallet holds ${native} wei, gas reserve is ${this.d.config.gasReserveWei}`);
        }
      }

      // ── 3. user limits (agent decisions only; exits are never restrained) ─
      check = 3;
      if (intent.origin === 'agent') await this.userLimits(ctx, intent, balances, amountIn, rates);

      // ── 4. slippage → amountOutMin ───────────────────────────────────────
      check = 4;
      const expectedOut = await this.d.chain.quoteExactInput(path, amountIn);
      if (expectedOut <= 0n) throw new CheckFailed(4, 'no_pool', 'quoter returned zero output');
      const slippageBps = ctx.profile.maxSlippageBps ?? this.d.config.defaultSlippageBps;
      const amountOutMin = (expectedOut * (BPS - BigInt(slippageBps))) / BPS;
      if (amountOutMin <= 0n) throw new CheckFailed(4, 'min_out_zero', `slippage ${slippageBps} bps leaves no minimum output`);

      // ── 5. price sanity ──────────────────────────────────────────────────
      check = 5;
      const poolPrice = toWholePrice(await rates.get(sellRoute), dec(ctx, intent.token), dec(ctx, ctx.quoteAsset));
      const refereePrice = await this.d.chain.refereePrice(intent.token, ctx.quoteAsset);
      const overrides: RiskApproved['overrides'] = [];
      let deviationBps: number | null = null;
      if (refereePrice !== null && refereePrice > 0) {
        deviationBps = (Math.abs(poolPrice - refereePrice) / refereePrice) * 10_000;
        if (deviationBps > this.d.config.priceToleranceBps) {
          if (this.guardTimeoutElapsed(intent)) {
            overrides.push('price_deviation_timeout');
          } else {
            throw new CheckFailed(
              5,
              'price_deviation',
              `pool price ${poolPrice} deviates ${deviationBps.toFixed(0)} bps from referee ${refereePrice} (tolerance ${this.d.config.priceToleranceBps})`,
            );
          }
        }
      }

      return { ok: true, tokenIn, tokenOut, path, amountIn, expectedOut, amountOutMin, slippageBps, poolPrice, refereePrice, deviationBps, overrides };
    } catch (e) {
      if (e instanceof CheckFailed) return { ok: false, code: e.code, message: e.message, check: e.check };
      if (e instanceof Rejection) return { ok: false, code: e.code, message: e.message, check };
      // Any other failure is a chain/RPC/DB read: fail closed, loudly.
      const msg = (e as Error)?.message?.split('\n')[0] ?? String(e);
      return { ok: false, code: 'chain_read_failed', message: msg, check };
    }
  }

  // ── step 0 ────────────────────────────────────────────────────────────────

  private async agentState(intent: RiskIntent): Promise<AgentRiskContext> {
    if (intent.origin !== 'agent' && intent.action !== 'sell') {
      throw new CheckFailed(0, 'bad_request', `${intent.origin} intents can only sell`);
    }
    if (intent.guard && intent.origin !== 'guard') throw new CheckFailed(0, 'bad_request', 'guard timing on a non-guard intent');

    const ctx = await this.d.store.loadAgent(intent.agentId);
    if (!ctx) throw new CheckFailed(0, 'unknown_agent', 'agent not found or has no config/wallet');
    if (ctx.status === 'retired') throw new CheckFailed(0, 'agent_retired', 'agent is retired');
    // guards and the user's own exits keep working for paused agents (§3.10); the agent only acts while active
    const ok = intent.origin === 'agent' ? ctx.status === 'active' : ctx.status === 'active' || ctx.status === 'paused';
    if (!ok) throw new CheckFailed(0, 'agent_not_active', `agent status ${ctx.status} cannot trade for origin ${intent.origin}`);
    if (ctx.quoteAsset !== this.d.config.usdg && ctx.quoteAsset !== this.d.config.weth) {
      throw new CheckFailed(0, 'quote_not_allowed', 'agent quote asset must be USDG or WETH');
    }
    return ctx;
  }

  // ── check 1 ───────────────────────────────────────────────────────────────

  private async routeFor(ctx: AgentRiskContext, intent: RiskIntent) {
    const token = intent.token;
    if (token === ctx.quoteAsset) throw new CheckFailed(1, 'token_not_allowed', 'cannot trade the quote asset against itself');
    // Exits of a token the agent still holds stay possible after the user removed it from its assets;
    // buys and agent decisions always require the token to be an asset.
    const heldExit = intent.action === 'sell' && intent.origin !== 'agent' && ctx.held[intent.mode].has(token);
    if (!ctx.assets.has(token) && !heldExit) throw new CheckFailed(1, 'token_not_allowed', `${token} is not in the agent's assets`);
    dec(ctx, token);
    dec(ctx, ctx.quoteAsset);

    const sellRoute = await this.d.store.route(token, ctx.quoteAsset);
    if (!sellRoute) throw new CheckFailed(1, 'no_pool', `no route from ${token} to ${ctx.quoteAsset}`);
    const decoded = decodePath(sellRoute);
    if (decoded.hops.length > MAX_HOPS) throw new CheckFailed(1, 'invalid_path', `route has ${decoded.hops.length} hops`);
    if (decoded.tokens[0] !== token || decoded.tokens[decoded.tokens.length - 1] !== ctx.quoteAsset) {
      throw new CheckFailed(1, 'internal_error', 'stored route endpoints do not match token/quote');
    }

    const path: Hex = intent.action === 'sell' ? sellRoute : reversePath(sellRoute);
    const tokenIn = intent.action === 'sell' ? token : ctx.quoteAsset;
    const tokenOut = intent.action === 'sell' ? ctx.quoteAsset : token;

    for (const t of decoded.tokens) {
      if (!ctx.stockTokens.has(t)) continue;
      if (await this.d.chain.isPaused(t)) throw new CheckFailed(1, 'token_paused', `stock token ${t} is paused`);
      if (await this.d.chain.isBlocked(t, ctx.wallet)) throw new CheckFailed(1, 'wallet_blocked', `wallet is blocked by ${t}`);
    }
    return { sellRoute, path, tokenIn, tokenOut };
  }

  // ── check 2 ───────────────────────────────────────────────────────────────

  private async amountIn(
    ctx: AgentRiskContext,
    intent: RiskIntent,
    balances: BalanceReader,
    tokenIn: Address,
    sellRoute: Hex,
    rates: RateCache,
  ): Promise<bigint> {
    const balance = await balances.token(ctx, tokenIn);
    const quoteDec = dec(ctx, ctx.quoteAsset);
    let amount: bigint;

    if (intent.action === 'buy') {
      if (intent.size.type !== 'quote_amount') throw new CheckFailed(2, 'amount_invalid', 'a buy must be sized as quote_amount');
      amount = parseDecimal(intent.size.value, quoteDec);
    } else if (intent.size.type === 'fraction_of_position') {
      const f = parseDecimal(intent.size.value, FRACTION_DECIMALS);
      if (f > 10n ** BigInt(FRACTION_DECIMALS)) throw new CheckFailed(2, 'amount_invalid', 'fraction_of_position must be in (0, 1]');
      if (balance === 0n) throw new CheckFailed(2, 'insufficient_balance', `no ${tokenIn} balance to sell`);
      amount = (balance * f) / 10n ** BigInt(FRACTION_DECIMALS);
    } else {
      // sell worth `quote_amount`: convert at the pool mid price
      const quoteRaw = parseDecimal(intent.size.value, quoteDec);
      const rate = await rates.get(sellRoute); // raw quote per raw token
      if (!(rate > 0)) throw new CheckFailed(2, 'no_pool', 'pool price is zero');
      const raw = Math.ceil(Number(quoteRaw) / rate);
      if (!Number.isFinite(raw)) throw new CheckFailed(2, 'amount_invalid', 'size cannot be converted at the pool price');
      amount = BigInt(raw);
    }

    if (amount <= 0n) throw new CheckFailed(2, 'amount_invalid', 'size rounds to zero');
    if (amount > balance) throw new CheckFailed(2, 'insufficient_balance', `size ${amount} exceeds balance ${balance} of ${tokenIn}`);
    return amount;
  }

  // ── check 3 ───────────────────────────────────────────────────────────────

  private async userLimits(ctx: AgentRiskContext, intent: RiskIntent, balances: BalanceReader, amountIn: bigint, rates: RateCache) {
    const p = ctx.profile;
    const needNav = (intent.action === 'buy' && (p.maxPositionPct !== null || p.maxExposurePct !== null)) || p.maxDailyLossPct !== null;
    const now = this.now();

    if (needNav) {
      const v = await this.valuation(ctx, balances, rates);
      if (intent.action === 'buy') {
        const buy = toWhole(amountIn, dec(ctx, ctx.quoteAsset));
        if (v.nav <= 0) throw new CheckFailed(3, 'insufficient_balance', 'agent NAV is zero');
        if (p.maxPositionPct !== null) {
          const pct = (((v.holdings.get(intent.token) ?? 0) + buy) / v.nav) * 100;
          if (pct > p.maxPositionPct) {
            throw new CheckFailed(3, 'exceeds_position_limit', `position would be ${pct.toFixed(2)}% of NAV (limit ${p.maxPositionPct}%)`);
          }
        }
        if (p.maxExposurePct !== null) {
          const pct = ((v.exposure + buy) / v.nav) * 100;
          if (pct > p.maxExposurePct) {
            throw new CheckFailed(3, 'exceeds_exposure_limit', `exposure would be ${pct.toFixed(2)}% of NAV (limit ${p.maxExposurePct}%)`);
          }
        }
      }
      if (p.maxTradesPerDay !== null) await this.tradesPerDay(ctx, intent, now);
      if (p.maxDailyLossPct !== null) {
        // the baseline is recorded on every agent evaluation, so it exists even if the first trade of the day is a sell
        const base = await this.d.store.dayBaseline(ctx.agentId, intent.mode, utcDay(now), v.nav);
        const lossPct = base > 0 ? ((base - v.nav) / base) * 100 : 0;
        // a loss limit stops new risk; the agent may still sell to reduce exposure
        if (intent.action === 'buy' && lossPct >= p.maxDailyLossPct) {
          throw new CheckFailed(3, 'exceeds_daily_loss', `NAV is down ${lossPct.toFixed(2)}% today (limit ${p.maxDailyLossPct}%)`);
        }
      }
    } else if (p.maxTradesPerDay !== null) {
      await this.tradesPerDay(ctx, intent, now);
    }
  }

  private async tradesPerDay(ctx: AgentRiskContext, intent: RiskIntent, now: Date) {
    const max = ctx.profile.maxTradesPerDay!;
    const n = await this.d.store.tradesToday(ctx.agentId, intent.mode, startOfUtcDay(now), intent.decisionId);
    if (n >= max) throw new CheckFailed(3, 'exceeds_trades_per_day', `${n} trades today (limit ${max})`);
  }

  /** NAV in whole quote units = quote balance + Σ asset balance × pool mid price. Gas ETH is outside NAV (§7). */
  private async valuation(ctx: AgentRiskContext, balances: BalanceReader, rates: RateCache) {
    const quoteDec = dec(ctx, ctx.quoteAsset);
    const holdings = new Map<Address, number>();
    let exposure = 0;
    for (const a of ctx.assets) {
      if (a === ctx.quoteAsset) continue;
      const bal = await balances.token(ctx, a);
      if (bal === 0n) continue;
      const route = await this.d.store.route(a, ctx.quoteAsset);
      if (!route) continue; // unpriced: shown as quantity elsewhere, never valued at zero or guessed
      const value = (Number(bal) * (await rates.get(route))) / 10 ** quoteDec;
      holdings.set(a, value);
      exposure += value;
    }
    const quoteBal = toWhole(await balances.token(ctx, ctx.quoteAsset), quoteDec);
    return { nav: quoteBal + exposure, exposure, holdings };
  }

  // ── check 5 ───────────────────────────────────────────────────────────────

  private guardTimeoutElapsed(intent: RiskIntent): boolean {
    if (intent.origin !== 'guard' || !intent.guard) return false;
    const elapsedMs = this.now().getTime() - intent.guard.firstTriggeredAt.getTime();
    return elapsedMs >= intent.guard.deviationTimeoutSeconds * 1000;
  }
}

/** One midRate read per route per evaluation. */
class RateCache {
  private readonly chain: RiskChain;
  private readonly cache = new Map<Hex, Promise<number>>();
  constructor(chain: RiskChain) {
    this.chain = chain;
  }
  get(path: Hex): Promise<number> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.chain.midRate(path);
      this.cache.set(path, p);
    }
    return p;
  }
}

function dec(ctx: AgentRiskContext, token: Address): number {
  const d = ctx.decimals.get(token);
  if (d === undefined) throw new Rejection('internal_error', `decimals unknown for ${token}`);
  return d;
}

/** Strict string-decimal → raw units. Excess fractional digits are rejected, never rounded. */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = DECIMAL.exec(value);
  if (!m) throw new CheckFailed(2, 'amount_invalid', `"${value}" is not a positive decimal`);
  if ((m[2]?.length ?? 1) - 1 > decimals) throw new CheckFailed(2, 'amount_invalid', `"${value}" has more than ${decimals} decimals`);
  const v = parseUnits(value, decimals);
  if (v === 0n) throw new CheckFailed(2, 'amount_invalid', 'size must be > 0');
  return v;
}

function toWhole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** raw quote per raw token → whole quote per whole token */
export function toWholePrice(rawRate: number, tokenDecimals: number, quoteDecimals: number): number {
  return rawRate * 10 ** (tokenDecimals - quoteDecimals);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
