/**
 * Staging helper: amountOutMin for a path at a given slippage, from QuoterV2 (same quote the signer checks).
 *   node packages/risk/scripts/quote.ts <path-hex> <amountIn> [slippageBps=100]
 * env: CHAIN_RPC_URLS, CHAIN_FACTORY, CHAIN_QUOTER_V2
 */
import { getAddress, type Hex } from 'viem';
import { ViemRiskChain } from '../src/chain.ts';

const [path, amountIn, bps = '100'] = process.argv.slice(2);
if (!path || !amountIn) throw new Error('usage: quote.ts <path> <amountIn> [slippageBps]');
const e = process.env;
const chain = new ViemRiskChain({ rpcUrls: e.CHAIN_RPC_URLS!.split(','), factory: getAddress(e.CHAIN_FACTORY!), quoter: getAddress(e.CHAIN_QUOTER_V2!), referees: new Map() });
const out = await chain.quoteExactInput(path as Hex, BigInt(amountIn));
console.log(((out * BigInt(10_000 - Number(bps))) / 10_000n).toString());
