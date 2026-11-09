import { z } from 'zod';
import { getAddress, isAddress, type Address } from 'viem';

const addr = z.string().refine((v) => isAddress(v, { strict: false }), 'must be an address').transform((v) => getAddress(v));
const positive = z.number().positive().finite();

/** User-defined rule alerts (architecture §3.14). Conditions on price, change, volume, liquidity, transfers, wallets. */
export const RuleSpec = z.discriminatedUnion('condition', [
  z.object({ condition: z.literal('price_above'), token: addr, price: positive }).strict(),
  z.object({ condition: z.literal('price_below'), token: addr, price: positive }).strict(),
  z.object({ condition: z.literal('change_pct'), token: addr, minutes: z.number().int().min(1).max(1440), pct: positive }).strict(),
  z.object({ condition: z.literal('volume_above'), token: addr, minutes: z.number().int().min(1).max(1440), amount: positive }).strict(),
  z.object({ condition: z.literal('liquidity_below'), pool: addr, liquidity: z.string().regex(/^[0-9]{1,40}$/) }).strict(),
  z.object({ condition: z.literal('large_transfer'), token: addr, amount: positive }).strict(),
  z.object({ condition: z.literal('wallet_activity'), address: addr }).strict(),
]);
export type RuleSpec = z.infer<typeof RuleSpec>;

export type TransferEvent = { block: bigint; txHash: string; token: Address; from: Address; to: Address; amount: number };

/** Data the rules read. Prices are USDG mid from snapshots; volumes and transfers come from the indexer. */
export interface RuleData {
  latestPrice(token: Address): Promise<{ price: number; ts: Date } | null>;
  priceAt(token: Address, at: Date): Promise<number | null>;
  /** Whole tokens swapped through the token's routed pools in the window. */
  swapVolume(token: Address, minutes: number): Promise<number>;
  poolLiquidity(pool: Address): Promise<bigint>;
  /** Highest block every transfer stream has reached (events beyond it are not yet known). */
  indexedTo(): Promise<bigint | null>;
  transfers(q: { token?: Address; wallet?: Address; minAmount?: number; fromBlock: bigint; toBlock: bigint }): Promise<TransferEvent[]>;
}

export type Evaluation = { fired: boolean; detail?: Record<string, unknown>; cursor?: bigint };

/** Evaluate one rule. Event rules resume from `cursor` so each event is seen once. */
export async function evaluate(spec: RuleSpec, data: RuleData, cursor: bigint | null): Promise<Evaluation> {
  switch (spec.condition) {
    case 'price_above':
    case 'price_below': {
      const p = await data.latestPrice(spec.token);
      if (!p) return { fired: false };
      const hit = spec.condition === 'price_above' ? p.price >= spec.price : p.price <= spec.price;
      return { fired: hit, detail: { price: p.price, threshold: spec.price, as_of: p.ts.toISOString() } };
    }
    case 'change_pct': {
      const now = await data.latestPrice(spec.token);
      if (!now) return { fired: false };
      const then = await data.priceAt(spec.token, new Date(now.ts.getTime() - spec.minutes * 60_000));
      if (!then) return { fired: false };
      const change = ((now.price - then) / then) * 100;
      return { fired: Math.abs(change) >= spec.pct, detail: { change_pct: change, from: then, to: now.price, minutes: spec.minutes, as_of: now.ts.toISOString() } };
    }
    case 'volume_above': {
      const v = await data.swapVolume(spec.token, spec.minutes);
      return { fired: v >= spec.amount, detail: { volume: v, threshold: spec.amount, minutes: spec.minutes } };
    }
    case 'liquidity_below': {
      const l = await data.poolLiquidity(spec.pool);
      return { fired: l < BigInt(spec.liquidity), detail: { liquidity: l.toString(), threshold: spec.liquidity } };
    }
    case 'large_transfer':
    case 'wallet_activity': {
      const head = await data.indexedTo();
      if (head === null) return { fired: false };
      // first evaluation starts at the current indexed head: no alerts for history
      if (cursor === null) return { fired: false, cursor: head };
      if (head <= cursor) return { fired: false, cursor };
      const events =
        spec.condition === 'large_transfer'
          ? await data.transfers({ token: spec.token, minAmount: spec.amount, fromBlock: cursor + 1n, toBlock: head })
          : await data.transfers({ wallet: spec.address, fromBlock: cursor + 1n, toBlock: head });
      return {
        fired: events.length > 0,
        cursor: head,
        detail: { count: events.length, events: events.slice(0, 5).map((e) => ({ block: e.block.toString(), tx: e.txHash, token: e.token, from: e.from, to: e.to, amount: e.amount })), to_block: head.toString() },
      };
    }
  }
}
