import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '@odin/db';
import { AuthService } from '../src/auth.ts';
import { AgentService } from '../src/agents.ts';
import { buildServer } from '../src/server.ts';
import { FundsService } from '../src/funds.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;
const DOMAIN = 'app.odin.test';
const URI = 'https://app.odin.test';
const rnd = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

describe.skipIf(!url)('API (postgres, real SIWE signatures)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let auth: AuthService;
  const USDG = rnd();
  const WETH = rnd();
  const TSLA = rnd();
  let clock = new Date();
  let funds: FundsService;
  const withdrawCalls: { agentId: string; token: Address | null; amount: bigint }[] = [];

  beforeAll(async () => {
    pool = createPool(url!, { max: 10 });
    for (const [a, d, s] of [[USDG, 6, 'USDG'], [WETH, 18, 'WETH'], [TSLA, 18, 'TSLA']] as const) {
      await pool.query('INSERT INTO tokens (address, decimals, symbol, name) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING', [a.toLowerCase(), d, s]);
    }
    auth = new AuthService({
      pool,
      config: { domain: DOMAIN, uri: URI, chainId: 4663, jwtKey: randomBytes(32), accessTtlSeconds: 900, refreshTtlSeconds: 86_400, nonceTtlSeconds: 600 },
      verify: (a) => verifyMessage(a),
      now: () => clock,
    });
    const agents = new AgentService({
      pool,
      usdg: USDG,
      weth: WETH,
      wallets: { addressFor: async () => rnd() },
      registry: { addToken: async (a: string) => ({ token: { address: getAddress(a), decimals: 18, symbol: 'X', name: 'X', isStockToken: false }, routes: [] }) },
    });
    funds = new FundsService({
      pool,
      chainId: 4663,
      readDecimals: async () => 18,
      executor: { executeWithdraw: async (j) => (withdrawCalls.push(j), { status: 'confirmed', txHash: '0xabc' }) },
      exporter: { exportKey: async () => ({ address: rnd(), privateKey: '0x01' }) },
    });
    app = buildServer({ auth, agents, funds, setPaperBalance: async () => {}, rateLimit: { perIpPerMinute: 1000, perUserPerMinute: 1000 } });
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, token?: string) => {
    const r = await app.inject({ method, url: path, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };

  async function signIn(account: PrivateKeyAccount, over: { domain?: string; chainId?: number } = {}) {
    const { body: n } = await call('POST', '/v1/auth/nonce');
    const message = createSiweMessage({ domain: over.domain ?? DOMAIN, uri: URI, address: account.address, chainId: over.chainId ?? 4663, nonce: n.nonce, version: '1', issuedAt: clock });
    const signature = await account.signMessage({ message });
    return { message, signature, res: await call('POST', '/v1/auth/verify', { message, signature }) };
  }

  it('signs in with SIWE and rejects replay, wrong domain, wrong chain and forged signatures', async () => {
    const alice = privateKeyToAccount(generatePrivateKey());
    const ok = await signIn(alice);
    expect(ok.res.status).toBe(200);
    expect(ok.res.body.address).toBe(alice.address);

    const replay = await call('POST', '/v1/auth/verify', { message: ok.message, signature: ok.signature });
    expect(replay.body.error.code).toBe('unauthorized');

    expect((await signIn(alice, { domain: 'evil.example' })).res.status).toBe(401);
    expect((await signIn(alice, { chainId: 1 })).res.status).toBe(401);

    const { body: n } = await call('POST', '/v1/auth/nonce');
    const message = createSiweMessage({ domain: DOMAIN, uri: URI, address: alice.address, chainId: 4663, nonce: n.nonce, version: '1' });
    const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message });
    expect((await call('POST', '/v1/auth/verify', { message, signature: forged })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse; logout-all kills access tokens', async () => {
    const bob = privateKeyToAccount(generatePrivateKey());
    const { res } = await signIn(bob);
    const r1 = await call('POST', '/v1/auth/refresh', { refreshToken: res.body.refreshToken });
    expect(r1.status).toBe(200);
    // reusing the old token = theft signal: whole family revoked, including the new one
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: res.body.refreshToken })).status).toBe(401);
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: r1.body.refreshToken })).status).toBe(401);
    expect((await call('GET', '/v1/me', undefined, r1.body.accessToken)).status).toBe(401);

    const s = (await signIn(bob)).res.body;
    expect((await call('GET', '/v1/me', undefined, s.accessToken)).status).toBe(200);
    await call('POST', '/v1/auth/logout-all', {}, s.accessToken);
    expect((await call('GET', '/v1/me', undefined, s.accessToken)).status).toBe(401);
  });

  it('agent lifecycle with ownership isolation, versioned config, activation rules and step-up for live', async () => {
    const carol = (await signIn(privateKeyToAccount(generatePrivateKey()))).res.body.accessToken;
    const dave = (await signIn(privateKeyToAccount(generatePrivateKey()))).res.body.accessToken;

    const a = (await call('POST', '/v1/agents', { name: 'tsla dips' }, carol)).body;
    expect(a).toMatchObject({ status: 'draft', mode: 'paper' });
    expect(a.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // another user can neither read nor modify it, and cannot learn that it exists
    expect((await call('GET', `/v1/agents/${a.id}`, undefined, dave)).status).toBe(404);
    expect((await call('POST', `/v1/agents/${a.id}/status`, { action: 'retire' }, dave)).status).toBe(404);
    expect((await call('GET', '/v1/agents', undefined, dave)).body).toEqual([]);

    expect((await call('POST', `/v1/agents/${a.id}/status`, { action: 'activate' }, carol)).body.error.code).toBe('bad_request');

    const cfg = { systemPrompt: 'buy dips', model: 'claude-opus-5-5', quoteAsset: 'USDG', cadenceSeconds: 300 };
    expect((await call('POST', `/v1/agents/${a.id}/config`, cfg, carol)).body).toEqual({ version: 1 });
    expect((await call('POST', `/v1/agents/${a.id}/config`, { ...cfg, cadenceSeconds: 600 }, carol)).body).toEqual({ version: 2 });
    expect((await call('POST', `/v1/agents/${a.id}/config`, { ...cfg, quoteAsset: 'TSLA' }, carol)).status).toBe(400);
    expect((await call('POST', `/v1/agents/${a.id}/config`, { ...cfg, model: 'gpt-x' }, carol)).status).toBe(400);
    expect((await call('POST', `/v1/agents/${a.id}/config`, { ...cfg, cadenceSeconds: 10 }, carol)).status).toBe(400);
    expect((await call('POST', `/v1/agents/${a.id}/config/rollback`, { version: 1 }, carol)).body).toEqual({ version: 3 });
    const versions = (await call('GET', `/v1/agents/${a.id}/configs`, undefined, carol)).body as unknown as { version: number; cadence_seconds: number }[];
    expect(versions.map((v) => [v.version, v.cadence_seconds])).toEqual([[3, 300], [2, 600], [1, 300]]);

    expect((await call('PUT', `/v1/agents/${a.id}/assets`, { tokens: [TSLA] }, carol)).status).toBe(200);
    expect((await call('PUT', `/v1/agents/${a.id}/tpsl`, { stopLoss: { mode: 'pct', value: 5 }, takeProfit: null }, carol)).status).toBe(200);
    expect((await call('PUT', `/v1/agents/${a.id}/risk`, { maxTradesPerDay: 10 }, carol)).status).toBe(200);
    expect((await call('POST', `/v1/agents/${a.id}/status`, { action: 'activate' }, carol)).body).toEqual({ status: 'active' });

    // live mode needs a SIWE signature from the last 10 minutes
    expect((await call('POST', `/v1/agents/${a.id}/mode`, { mode: 'live' }, carol)).body).toEqual({ mode: 'live' });
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await call('POST', `/v1/agents/${a.id}/mode`, { mode: 'live' }, carol)).body.error.code).toBe('unauthorized');

    const got = (await call('GET', `/v1/agents/${a.id}`, undefined, carol)).body;
    expect(got).toMatchObject({ status: 'active', mode: 'live', config: { version: 3 }, risk: { max_trades_per_day: 10 }, tpSl: { sl_enabled: true, tp_enabled: false } });

    expect((await call('POST', `/v1/agents/${a.id}/status`, { action: 'retire' }, carol)).body).toEqual({ status: 'retired' });
    expect((await call('POST', `/v1/agents/${a.id}/status`, { action: 'resume' }, carol)).status).toBe(400);
  });

  it('funds: withdraw to the owner with step-up, export message, close-all queue; other users get 404', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    clock = new Date();
    const t = (await signIn(owner)).res.body.accessToken;
    const other = (await signIn(privateKeyToAccount(generatePrivateKey()))).res.body.accessToken;
    const a = (await call('POST', '/v1/agents', { name: 'funds' }, t)).body;

    const w = await call('POST', `/v1/agents/${a.id}/withdraw`, { token: USDG, amount: '12.5' }, t);
    expect(w.body).toMatchObject({ status: 'confirmed', txHash: '0xabc', recipient: owner.address, amount: '12500000' });
    expect(withdrawCalls.at(-1)).toMatchObject({ agentId: a.id, token: USDG, amount: 12_500_000n });
    expect((await call('POST', `/v1/agents/${a.id}/withdraw`, { token: 'native', amount: '0.1', recipient: rnd() }, t)).status).toBe(400);
    expect((await call('POST', `/v1/agents/${a.id}/withdraw`, { token: 'native', amount: '0.1' }, other)).status).toBe(404);
    expect(((await call('GET', `/v1/agents/${a.id}/withdrawals`, undefined, t)).body as unknown as unknown[]).length).toBe(1);

    const m = (await call('POST', `/v1/agents/${a.id}/export/message`, {}, t)).body;
    expect(m.message).toContain(`Wallet: ${getAddress(a.wallet)}`);
    expect(m.message).toContain(`Agent: ${a.id}`);

    // closing needs an active or paused agent; the request is queued for the guard watcher
    expect((await call('POST', `/v1/agents/${a.id}/close-all`, {}, t)).body.error.code).toBe('bad_request');
    await pool.query("UPDATE agents SET status = 'paused' WHERE id = $1", [a.id]);
    const c = (await call('POST', `/v1/agents/${a.id}/close-all`, {}, t)).body;
    expect(c).toMatchObject({ status: 'pending' });
    expect((await call('GET', `/v1/agents/${a.id}/close-requests/${c.requestId}`, undefined, t)).body).toMatchObject({ status: 'pending', mode: 'paper' });
    expect((await call('GET', `/v1/agents/${a.id}/close-requests/${c.requestId}`, undefined, other)).status).toBe(404);

    // stale SIWE: money-moving actions refuse until the user signs in again
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await call('POST', `/v1/agents/${a.id}/withdraw`, { token: 'native', amount: '0.1' }, t)).body.error.code).toBe('unauthorized');
    expect((await call('POST', `/v1/agents/${a.id}/export/message`, {}, t)).body.error.code).toBe('unauthorized');
  });

  it('rejects unauthenticated access and malformed ids', async () => {
    expect((await call('GET', '/v1/agents')).status).toBe(401);
    const t = (await signIn(privateKeyToAccount(generatePrivateKey()))).res.body.accessToken;
    expect((await call('GET', '/v1/agents/not-a-uuid', undefined, t)).status).toBe(404);
  });
});
