import { createPublicClient, fallback, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import type { Pool } from '@odin/db';
import { averageCost, type Flow } from './cost.ts';

export interface PortfolioChain {
  head(): Promise<bigint>;
  balance(token: Address | null, wallet: Address): Promise<bigint>;
  /** QuoterV2 output for selling `amount` along `path`; null when the quote fails. */
  quote(path: Hex, amount: bigint): Promise<bigint | null>;
}

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const quoterAbi = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)']);

export class ViemPortfolioChain implements PortfolioChain {
  private readonly c;
  private readonly quoter: Address;
  constructor(rpcUrls: string[], quoter: Address) {
    this.c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 10_000 }))) });
    this.quoter = quoter;
  }
  head() {
    return this.c.getBlockNumber();
  }
  balance(token: Address | null, wallet: Address) {
    return token === null ? this.c.getBalance({ address: wallet }) : this.c.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [wallet] });
  }
  async quote(path: Hex, amount: bigint) {
    try {
      return (await this.c.simulateContract({ address: this.quoter, abi: quoterAbi, functionName: 'quoteExactInput', args: [path, amount] })).result[0];
    } catch {
      return null;
    }
  }
}

export type Holding = {
  token: Address | 'native';
  symbol: string;
  decimals: number;
  qty: string;
  /** Realizable USDG value (quoter, fees + impact included); null = unpriced, never counted as zero. */
  valueUsdg: number | null;
  priced: boolean;
  costBasisUsdg: number | null;
  realizedPnlUsdg: number | null;
  unrealizedPnlUsdg: number | null;
  /** Indexed history explains the whole on-chain balance (otherwise cost basis is unknown). */
  historyComplete: boolean;
};

export type WalletView = { address: Address; kind: string; label: string | null; holdings: Holding[]; valueUsdg: number; unpriced: number; asOfBlock: string };

export type PortfolioDeps = { pool: Pool; chain: PortfolioChain; usdg: Address; weth: Address };

/** Portfolio Tracker (architecture §3.15). Read-only: nothing here can sign. */
export class PortfolioService {
  private readonly d: PortfolioDeps;
  constructor(deps: PortfolioDeps) {
    this.d = deps;
  }

  async wallet(address: Address, kind = 'watch', label: string | null = null): Promise<WalletView> {
    const head = await this.d.chain.head();
    const tokens = (await this.d.pool.query<{ address: string; symbol: string; decimals: number }>('SELECT address, symbol, decimals FROM tokens ORDER BY symbol')).rows;
    const holdings: Holding[] = [];
    const wethPrice = await this.realizableUsdg(this.d.weth, 10n ** 18n, 18);

    const native = await this.d.chain.balance(null, address);
    if (native > 0n) {
      const v = wethPrice === null ? null : (Number(native) / 1e18) * wethPrice;
      holdings.push({ token: 'native', symbol: 'ETH', decimals: 18, qty: native.toString(), valueUsdg: v, priced: v !== null, costBasisUsdg: null, realizedPnlUsdg: null, unrealizedPnlUsdg: null, historyComplete: false });
    }

    for (const t of tokens) {
      const token = getAddress(t.address);
      const bal = await this.d.chain.balance(token, address);
      const history = await this.history(address, token, t.decimals);
      if (bal === 0n && history.flows.length === 0) continue;
      const qty = Number(bal) / 10 ** t.decimals;
      const priceNow = bal === 0n ? null : token === this.d.usdg ? 1 : await this.realizableUsdg(token, bal, t.decimals);
      const value = bal === 0n ? 0 : priceNow === null ? null : qty * priceNow;
      const cost = averageCost(history.flows);
      // history explains the balance only if the reconstructed quantity matches the chain
      const complete = history.complete && Math.abs(cost.qty - qty) <= Math.max(1e-9, qty * 1e-9);
      const costBasis = complete ? cost.costBasis : null;
      holdings.push({
        token, symbol: t.symbol, decimals: t.decimals, qty: bal.toString(), valueUsdg: value, priced: value !== null,
        costBasisUsdg: costBasis, realizedPnlUsdg: complete ? cost.realizedPnl : null,
        unrealizedPnlUsdg: value !== null && costBasis !== null ? value - costBasis : null, historyComplete: complete,
      });
    }

    for (const h of holdings) {
      if (h.token === 'native') continue;
      await this.d.pool.query(
        `INSERT INTO wallet_positions (address, token_address, qty, cost_basis, realized_pnl, as_of_block, value_usdg, unrealized_pnl, priced, history_complete, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (address, token_address) DO UPDATE SET qty = EXCLUDED.qty, cost_basis = EXCLUDED.cost_basis, realized_pnl = EXCLUDED.realized_pnl,
           as_of_block = EXCLUDED.as_of_block, value_usdg = EXCLUDED.value_usdg, unrealized_pnl = EXCLUDED.unrealized_pnl, priced = EXCLUDED.priced,
           history_complete = EXCLUDED.history_complete, updated_at = now()`,
        [address.toLowerCase(), h.token.toLowerCase(), h.qty, h.costBasisUsdg, h.realizedPnlUsdg, head.toString(), h.valueUsdg, h.unrealizedPnlUsdg, h.priced, h.historyComplete],
      );
    }
    const priced = holdings.filter((h) => h.valueUsdg !== null);
    return {
      address, kind, label, holdings,
      valueUsdg: priced.reduce((a, h) => a + (h.valueUsdg ?? 0), 0),
      unpriced: holdings.length - priced.length,
      asOfBlock: head.toString(),
    };
  }

  /** Aggregate view across every wallet the user tracks (SIWE, agents, watch-only) plus per-wallet views. */
  async forUser(userId: string) {
    const ws = await this.d.pool.query<{ address: string; kind: string; label: string | null }>('SELECT address, kind, label FROM tracked_wallets WHERE user_id = $1 ORDER BY kind, address', [userId]);
    const wallets: WalletView[] = [];
    for (const w of ws.rows) wallets.push(await this.wallet(getAddress(w.address), w.kind, w.label));
    return {
      valueUsdg: wallets.reduce((a, w) => a + w.valueUsdg, 0),
      unpriced: wallets.reduce((a, w) => a + w.unpriced, 0),
      asOfBlock: wallets.reduce((m, w) => (BigInt(w.asOfBlock) > BigInt(m) ? w.asOfBlock : m), '0'),
      wallets,
    };
  }

  /** Whole quote units (USDG) per whole token if `amount` were sold now along the stored route. */
  private async realizableUsdg(token: Address, amount: bigint, decimals: number): Promise<number | null> {
    if (token === this.d.usdg) return 1;
    const r = await this.d.pool.query<{ path: Hex; quote_address: string }>(
      'SELECT path, quote_address FROM routes WHERE token_address = $1 ORDER BY (quote_address = $2) DESC LIMIT 1',
      [token.toLowerCase(), this.d.usdg.toLowerCase()],
    );
    const route = r.rows[0];
    if (!route) return null;
    const out = await this.d.chain.quote(route.path, amount);
    if (out === null || out === 0n) return null;
    const whole = Number(amount) / 10 ** decimals;
    // USDG is pinned and verified on-chain at 6 decimals
    if (getAddress(route.quote_address) === this.d.usdg) return Number(out) / 1e6 / whole;
    const weth = await this.realizableUsdg(this.d.weth, out, 18);
    return weth === null ? null : ((Number(out) / 1e18) * weth) / whole;
  }

  /** Indexed transfers in order, each priced at the USDG snapshot at (or just before) its time. */
  private async history(wallet: Address, token: Address, decimals: number): Promise<{ flows: Flow[]; complete: boolean }> {
    const w = wallet.toLowerCase();
    const r = await this.d.pool.query<{ from: string; amount: string; price: string | null }>(
      `SELECT t."from", t.amount,
              CASE WHEN t.token_address = $3 THEN 1 ELSE
                (SELECT price FROM market_snapshots s WHERE s.token_address = t.token_address AND s.ts <= t.block_time
                   AND s.ts > t.block_time - interval '1 day' ORDER BY s.ts DESC LIMIT 1) END AS price
         FROM transfers t
        WHERE t.token_address = $1 AND (t."from" = $2 OR t."to" = $2) AND t."from" <> t."to"
        ORDER BY t.block, t.log_index`,
      [token.toLowerCase(), w, this.d.usdg.toLowerCase()],
    );
    const s = await this.d.pool.query('SELECT 1 FROM indexer_state WHERE stream = $1', [`transfer:${token.toLowerCase()}`]);
    return {
      complete: !!s.rowCount,
      flows: r.rows.map((x) => ({ direction: x.from === w ? 'out' : 'in', amount: Number(x.amount) / 10 ** decimals, priceUsdg: x.price === null ? null : Number(x.price) })),
    };
  }
}
