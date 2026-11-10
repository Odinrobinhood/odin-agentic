import { readFileSync } from 'node:fs';
import { createPublicClient, fallback, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { Executor, FallbackChain, HttpSignerClient, PgExecutionStore, loadExecutorConfig } from '@odin/executor';
import { Rejection, verifyWalletSignature, type RejectionCode } from '@odin/shared';
import { createPool } from '@odin/db';
import { loadMarketConfig, PgMarketStore, TokenRegistry, ViemMarketChain } from '@odin/market';
import { PgRuntimeStore } from '@odin/runtime';
import { AuthService } from './auth.ts';
import { AgentService } from './agents.ts';
import { buildServer } from './server.ts';
import { FundsService } from './funds.ts';
import { NotificationService } from './notifications.ts';
import { StatusService } from './status.ts';
import { AlertService } from './alerts.ts';
import { BacktestService } from './backtests.ts';
import { PortfolioService, ViemPortfolioChain } from '@odin/portfolio';
import Anthropic from '@anthropic-ai/sdk';
import { AnalystEngine, AnalystStore, AnalystTools, ClaudeAnalystLLM } from '@odin/analyst';
import { PgTokenMeter } from '@odin/decision';

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env ${key}`);
  return v;
}

const market = loadMarketConfig();
const pool = createPool(market.databaseUrl, { max: 10 });
const chain = createPublicClient({ transport: fallback(market.rpcUrls.map((u) => http(u, { timeout: 8_000 }))) });
const agentToken = readFileSync(req('SIGNER_AGENT_TOKEN_FILE'), 'utf8').trim();

const auth = new AuthService({
  pool,
  config: {
    domain: req('API_SIWE_DOMAIN'),
    uri: req('API_SIWE_URI'),
    chainId: market.chainId,
    jwtKey: new Uint8Array(readFileSync(req('API_JWT_KEY_FILE'))),
    accessTtlSeconds: 15 * 60, // architecture §3.2
    refreshTtlSeconds: 30 * 86_400,
    nonceTtlSeconds: 10 * 60,
  },
  // EOAs verified locally; ERC-1271 smart wallets only when every configured RPC agrees (never one RPC's word)
  verify: ({ address, message, signature }) => verifyWalletSignature(market.rpcUrls, address, message, signature),
});

const agents = new AgentService({
  pool,
  registry: new TokenRegistry(new ViemMarketChain(market), new PgMarketStore(pool), market),
  usdg: market.usdg,
  weth: market.weth,
  wallets: {
    addressFor: async (derivationIndex) => {
      const res = await fetch(`${req('SIGNER_AGENT_URL')}/v1/wallet`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ derivationIndex: derivationIndex.toString() }),
      });
      if (!res.ok) throw new Error(`signer wallet endpoint ${res.status}`);
      return getAddress(((await res.json()) as { address: Address }).address);
    },
  },
});

const exCfg = loadExecutorConfig();
const executor = new Executor({
  config: exCfg,
  chain: new FallbackChain(exCfg.rpcUrls),
  signer: new HttpSignerClient(req('SIGNER_AGENT_URL'), agentToken),
  store: new PgExecutionStore(pool),
});
const funds = new FundsService({
  pool,
  executor,
  chainId: market.chainId,
  readDecimals: (token) => chain.readContract({ address: token, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' }),
  exporter: {
    exportKey: async (body) => {
      const res = await fetch(`${req('SIGNER_AGENT_URL')}/v1/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = (await res.json()) as { address: Address; privateKey: Hex } & { error?: { code: RejectionCode; message: string } };
      if (!res.ok || out.error) throw new Rejection(out.error?.code ?? 'internal_error', out.error?.message ?? `signer ${res.status}`);
      return out;
    },
  },
});

const portfolio = new PortfolioService({ pool, chain: new ViemPortfolioChain(market.rpcUrls, market.quoter), usdg: market.usdg, weth: market.weth });
const analyst = {
  store: new AnalystStore(pool),
  engine: new AnalystEngine({
    // without ANTHROPIC_API_KEY every call fails and the route answers llm_unavailable
    llm: process.env.ANTHROPIC_API_KEY ? new ClaudeAnalystLLM(new Anthropic()) : { call: async () => { throw new Error('no LLM credential configured on this server'); } },
    tools: new AnalystTools({ pool, rpcUrls: market.rpcUrls, usdg: market.usdg, portfolio: (userId) => portfolio.forUser(userId) }),
    meter: new PgTokenMeter(pool),
    config: { model: process.env.ANALYST_MODEL ?? 'claude-opus-5-5', dailyTokenBudget: Number(process.env.DECISION_DAILY_TOKEN_BUDGET ?? 2_000_000) },
  }),
};

const runtimeStore = new PgRuntimeStore(pool);
const app = buildServer({
  pool,
  portfolio,
  analyst,
  alerts: new AlertService(pool),
  backtests: new BacktestService(pool),
  auth, agents, funds, notifications: new NotificationService(pool),
  status: new StatusService(pool), setPaperBalance: (a, q, raw) => runtimeStore.setPaperBalance(a, q, raw) });
const [host, port] = (process.env.API_LISTEN ?? '127.0.0.1:7500').split(':');
await app.listen({ host: host!, port: Number(port) });
console.log(JSON.stringify({ msg: 'api up', listen: `${host}:${port}`, domain: process.env.API_SIWE_DOMAIN }));
