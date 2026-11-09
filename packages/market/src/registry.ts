import { getAddress, isAddress, type Address } from 'viem';
import { Rejection, sanitizeName, sanitizeSymbol } from '@odin/shared';
import type { MarketChain } from './chain.ts';
import { findRoute, type Route, type RoutingConfig } from './routing.ts';
import type { MarketStore, TokenRow } from './store.ts';

export type AddTokenResult = { token: TokenRow; routes: Route[] };

/**
 * Token registry (architecture §3.6). Identity is always the contract address; symbol and name are
 * attacker-controlled display strings and are sanitized before they are stored.
 */
export class TokenRegistry {
  private readonly chain: MarketChain;
  private readonly store: MarketStore;
  private readonly cfg: RoutingConfig;

  constructor(chain: MarketChain, store: MarketStore, cfg: RoutingConfig) {
    this.chain = chain;
    this.store = store;
    this.cfg = cfg;
  }

  /** The quote assets every token is routed to: the base assets USDG and WETH. */
  get quotes(): Address[] {
    return [this.cfg.usdg, this.cfg.weth];
  }

  /** (Re)register USDG and WETH with fresh metadata and routes; they are the quote side of every route. */
  async ensureBaseAssets(): Promise<void> {
    for (const q of this.quotes) await this.addToken(q);
  }

  async addToken(raw: string): Promise<AddTokenResult> {
    if (!isAddress(raw, { strict: false })) throw new Rejection('bad_request', 'not an address');
    const address = getAddress(raw);

    let meta;
    try {
      meta = await this.chain.tokenMeta(address);
    } catch (e) {
      throw new Rejection('chain_read_failed', `not an ERC-20 or unreadable: ${(e as Error).message.split('\n')[0]}`);
    }
    if (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 77) throw new Rejection('bad_request', `invalid decimals ${meta.decimals}`);
    const token: TokenRow = {
      address,
      decimals: meta.decimals,
      symbol: sanitizeSymbol(meta.symbol),
      name: sanitizeName(meta.name),
      isStockToken: await this.chain.hasStockControls(address),
    };

    const routes = await this.routesFor(token);
    const isBase = this.quotes.includes(address);
    if (routes.length === 0 && !isBase) throw new Rejection('no_pool', 'no pool against USDG or WETH on Robinhood Chain');

    await this.store.upsertToken(token);
    await this.store.replaceRoutes(address, routes);
    return { token, routes };
  }

  /** Re-run routing for every registered token (liquidity moves); tokens keep their last routes on read errors. */
  async refreshRoutes(): Promise<{ refreshed: number; failed: Address[] }> {
    const failed: Address[] = [];
    let refreshed = 0;
    for (const t of await this.store.listTokens()) {
      try {
        await this.store.replaceRoutes(t.address, await this.routesFor(t));
        refreshed++;
      } catch {
        failed.push(t.address);
      }
    }
    return { refreshed, failed };
  }

  private async routesFor(token: TokenRow): Promise<Route[]> {
    const routes: Route[] = [];
    for (const q of this.quotes) {
      if (q === token.address) continue;
      const r = await findRoute(this.chain, this.cfg, token.address, q, { token: token.decimals, quote: await this.quoteDecimals(q) });
      if (r) routes.push(r);
    }
    return routes;
  }

  private async quoteDecimals(q: Address): Promise<number> {
    const t = await this.store.getToken(q);
    return t ? t.decimals : (await this.chain.tokenMeta(q)).decimals;
  }
}
