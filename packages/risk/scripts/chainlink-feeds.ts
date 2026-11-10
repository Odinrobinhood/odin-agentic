/**
 * Builds deploy/chainlink.mainnet.json: which Chainlink feed referees which token (risk check 5).
 *
 *   node packages/risk/scripts/chainlink-feeds.ts > deploy/chainlink.mainnet.json
 *   (env: CHAIN_RPC_URLS, CHAIN_WETH, DATABASE_URL with a populated token_catalog)
 *
 * Every entry is verified on-chain, never guessed:
 * - the feed is listed in Chainlink's reference data for Robinhood Chain mainnet;
 * - description() is read from the proxy and decimals() is 8, latestRoundData() is positive;
 * - a Stock Token feed maps to exactly ONE token with that symbol that is a beacon proxy of Robinhood's
 *   Stock Token beacon (anyone can deploy a token called "NVDA"; only Robinhood's beacon proxies count);
 * - ETH / USD referees WETH. Other crypto feeds are skipped (no verified token address for them).
 * A 24/7 feed is preferred over the 24/5 one when both exist (DEX pools trade on weekends).
 */
import { createPublicClient, fallback, getAddress, http, parseAbi, type Address } from 'viem';
import pg from 'pg';

const SOURCE = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const feedAbi = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);

type RefFeed = { name: string; proxyAddress: string; heartbeat: number; docs?: { baseAsset?: string; assetClass?: string } };

const rpcUrls = (process.env.CHAIN_RPC_URLS ?? '').split(',').filter(Boolean);
if (!rpcUrls.length || !process.env.CHAIN_WETH) throw new Error('CHAIN_RPC_URLS and CHAIN_WETH are required');
const c = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u, { timeout: 20_000 }))) });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://odin@/odin?host=/var/run/postgresql' });
await db.connect();

const list = (await (await fetch(SOURCE)).json()) as RefFeed[];
const symbolOf = (f: RefFeed) => f.name.replace(/^Robinhood /, '').split(/[ /(-]/)[0]!.toUpperCase();
const is247 = (f: RefFeed) => f.name.includes('(24/7)');

async function verifyFeed(f: RefFeed) {
  const feed = getAddress(f.proxyAddress);
  const [description, decimals, round] = await Promise.all([
    c.readContract({ address: feed, abi: feedAbi, functionName: 'description' }),
    c.readContract({ address: feed, abi: feedAbi, functionName: 'decimals' }),
    c.readContract({ address: feed, abi: feedAbi, functionName: 'latestRoundData' }),
  ]);
  if (decimals !== 8 || round[1] <= 0n) throw new Error(`${f.name}: unexpected decimals ${decimals} / answer ${round[1]}`);
  return { feed, description, maxAgeSeconds: f.heartbeat + 3600 };
}

async function stockToken(symbol: string): Promise<Address | null> {
  const r = await db.query<{ address: string }>(`SELECT address FROM token_catalog WHERE upper(symbol) = $1 AND is_stock_token`, [symbol]);
  const authentic: Address[] = [];
  for (const { address } of r.rows) {
    const slot = await c.getStorageAt({ address: address as Address, slot: BEACON_SLOT });
    if (slot && `0x${slot.slice(26)}`.toLowerCase() === STOCK_BEACON) authentic.push(getAddress(address));
  }
  return authentic.length === 1 ? authentic[0]! : null;
}

const out: { symbol: string; token: Address; feed: Address; description: string; maxAgeSeconds: number }[] = [];
const skipped: string[] = [];
const eth = list.find((f) => f.name === 'ETH / USD');
if (eth) out.push({ symbol: 'WETH', token: getAddress(process.env.CHAIN_WETH), ...(await verifyFeed(eth)) });

const equities = list.filter((f) => f.name.startsWith('Robinhood '));
for (const symbol of [...new Set(equities.map(symbolOf))].sort()) {
  const candidates = equities.filter((f) => symbolOf(f) === symbol).sort((a, b) => Number(is247(b)) - Number(is247(a)));
  const token = await stockToken(symbol);
  if (!token) {
    skipped.push(`${symbol} (no unique Robinhood Stock Token in the catalog)`);
    continue;
  }
  out.push({ symbol, token, ...(await verifyFeed(candidates[0]!)) });
}
await db.end();
console.log(JSON.stringify({ source: SOURCE, generatedAt: new Date().toISOString().slice(0, 10), feeds: out }, null, 2));
console.error(`mapped ${out.length}; skipped: ${skipped.join(', ') || 'none'}`);
