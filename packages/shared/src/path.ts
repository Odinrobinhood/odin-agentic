import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { isFeeTier, type FeeTier } from './chain.ts';
import { Rejection } from './codes.ts';

export type Hop = { tokenIn: Address; fee: FeeTier; tokenOut: Address };
export type DecodedPath = { tokens: Address[]; fees: FeeTier[]; hops: Hop[] };

const ADDR = 20;
const FEE = 3;

/** Encode a Uniswap v3 path: token (20) | fee (3) | token (20) | ... */
export function encodePath(tokens: Address[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Rejection('invalid_path', 'path needs n tokens and n-1 fees');
  }
  let out = '0x';
  tokens.forEach((t, i) => {
    out += getAddress(t).slice(2).toLowerCase();
    const fee = fees[i];
    if (fee !== undefined) {
      if (!isFeeTier(fee)) throw new Rejection('bad_fee_tier', `fee ${fee} is not a valid tier`);
      out += fee.toString(16).padStart(FEE * 2, '0');
    }
  });
  return out as Hex;
}

/** Decode and structurally validate a path. Throws Rejection on any malformation. */
export function decodePath(path: Hex): DecodedPath {
  if (!/^0x[0-9a-fA-F]*$/.test(path)) throw new Rejection('invalid_path', 'path is not hex');
  const bytes = (path.length - 2) / 2;
  if (!Number.isInteger(bytes) || bytes < ADDR + FEE + ADDR || (bytes - ADDR) % (ADDR + FEE) !== 0) {
    throw new Rejection('invalid_path', `path length ${bytes} bytes is malformed`);
  }
  const body = path.slice(2);
  const tokens: Address[] = [];
  const fees: FeeTier[] = [];
  let i = 0;
  for (;;) {
    const raw = `0x${body.slice(i, i + ADDR * 2)}`;
    if (!isAddress(raw, { strict: false })) throw new Rejection('invalid_path', 'bad address in path');
    tokens.push(getAddress(raw));
    i += ADDR * 2;
    if (i >= body.length) break;
    const fee = parseInt(body.slice(i, i + FEE * 2), 16);
    if (!isFeeTier(fee)) throw new Rejection('bad_fee_tier', `fee ${fee} is not a valid tier`);
    fees.push(fee);
    i += FEE * 2;
  }
  const hops: Hop[] = fees.map((fee, k) => ({ tokenIn: tokens[k]!, fee, tokenOut: tokens[k + 1]! }));
  return { tokens, fees, hops };
}
