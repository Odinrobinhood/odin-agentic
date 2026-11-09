import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type { Address, Hex } from 'viem';
import { Rejection, type RejectionCode } from '@odin/shared';
import type { AuthService } from './auth.ts';
import { CloseAllInput, ExportInput, WithdrawInput, type FundsService } from './funds.ts';
import { AgentService, AssetsInput, ConfigInput, GuardOverrideInput, ModeInput, PaperFundInput, RiskInput, StatusInput, TpSlInput } from './agents.ts';

export type ApiDeps = {
  auth: AuthService;
  agents: AgentService;
  funds: FundsService;
  setPaperBalance: (agentId: string, quote: Address, raw: bigint) => Promise<void>;
  /** Fixed-window limits (architecture §6): per IP for auth routes, per user for everything else. */
  rateLimit?: { perIpPerMinute: number; perUserPerMinute: number };
  /** Going live requires a SIWE signature at most this old (step-up). */
  stepUpSeconds?: number;
};

type Authed = FastifyRequest & { user: { userId: string; address: Address; family: string } };

const STATUS: Partial<Record<RejectionCode, number>> = { unauthorized: 401, bad_request: 400, unknown_agent: 404 };

function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new Rejection('bad_request', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

class Window {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  take(key: string, limit: number): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + 60_000 });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= limit;
  }
}

export function buildServer(d: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: '127.0.0.1' });
  const limits = d.rateLimit ?? { perIpPerMinute: 60, perUserPerMinute: 300 };
  const win = new Window();
  const stepUp = d.stepUpSeconds ?? 600;
  const json = (s: unknown) => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  // every rejection reaches the client with its machine-readable code (architecture §2.6)
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof Rejection) return reply.status(STATUS[err.code] ?? 422).send({ error: { code: err.code, message: err.message } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    console.error(JSON.stringify({ msg: 'api error', error: err.message }));
    return reply.status(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  const authed = async (req: FastifyRequest, _reply: FastifyReply) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) throw new Rejection('unauthorized', 'missing bearer token');
    const u = await d.auth.authenticate(h.slice(7));
    if (!win.take(`u:${u.userId}`, limits.perUserPerMinute)) throw new Rejection('bad_request', 'rate limited');
    (req as Authed).user = u;
  };
  const ipLimited = async (req: FastifyRequest) => {
    if (!win.take(`ip:${req.ip}`, limits.perIpPerMinute)) throw new Rejection('bad_request', 'rate limited');
  };
  const uid = (req: FastifyRequest) => (req as Authed).user.userId;
  const aid = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/healthz', async () => ({ ok: true, commit: process.env.BUILD_COMMIT ?? 'dev' }));

  // ── auth ────────────────────────────────────────────────────────────────────
  app.post('/v1/auth/nonce', { preHandler: ipLimited }, async () => d.auth.nonce());
  app.post('/v1/auth/verify', { preHandler: ipLimited }, async (req) => {
    const b = parse(z.object({ message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).strict(), req.body);
    return d.auth.login(b.message, b.signature as Hex, req.headers['user-agent']);
  });
  app.post('/v1/auth/refresh', { preHandler: ipLimited }, async (req) => {
    const b = parse(z.object({ refreshToken: z.string().min(20).max(200) }).strict(), req.body);
    return d.auth.refresh(b.refreshToken, req.headers['user-agent']);
  });
  app.post('/v1/auth/logout', { preHandler: authed }, async (req) => {
    await d.auth.logout(uid(req), (req as Authed).user.family);
    return { ok: true };
  });
  app.post('/v1/auth/logout-all', { preHandler: authed }, async (req) => {
    await d.auth.logoutAll(uid(req));
    return { ok: true };
  });
  app.get('/v1/me', { preHandler: authed }, async (req) => ({ userId: uid(req), address: (req as Authed).user.address }));

  // ── agents ──────────────────────────────────────────────────────────────────
  app.get('/v1/agents', { preHandler: authed }, async (req) => json(await d.agents.list(uid(req))));
  app.post('/v1/agents', { preHandler: authed }, async (req) => d.agents.create(uid(req), parse(z.object({ name: z.string() }).strict(), req.body).name));
  app.get('/v1/agents/:id', { preHandler: authed }, async (req) => json(await d.agents.get(uid(req), aid(req))));
  app.patch('/v1/agents/:id', { preHandler: authed }, async (req) => {
    await d.agents.rename(uid(req), aid(req), parse(z.object({ name: z.string() }).strict(), req.body).name);
    return { ok: true };
  });
  app.post('/v1/agents/:id/config', { preHandler: authed }, async (req) => d.agents.setConfig(uid(req), aid(req), parse(ConfigInput, req.body)));
  app.get('/v1/agents/:id/configs', { preHandler: authed }, async (req) => json(await d.agents.configs(uid(req), aid(req))));
  app.post('/v1/agents/:id/config/rollback', { preHandler: authed }, async (req) =>
    d.agents.rollback(uid(req), aid(req), parse(z.object({ version: z.number().int().positive() }).strict(), req.body).version),
  );
  app.put('/v1/agents/:id/assets', { preHandler: authed }, async (req) => json(await d.agents.setAssets(uid(req), aid(req), parse(AssetsInput, req.body).tokens)));
  app.put('/v1/agents/:id/risk', { preHandler: authed }, async (req) => {
    await d.agents.setRisk(uid(req), aid(req), parse(RiskInput, req.body));
    return { ok: true };
  });
  app.put('/v1/agents/:id/tpsl', { preHandler: authed }, async (req) => {
    await d.agents.setTpSl(uid(req), aid(req), parse(TpSlInput, req.body));
    return { ok: true };
  });
  app.put('/v1/agents/:id/positions/:positionId/guards', { preHandler: authed }, async (req) => {
    const { positionId } = req.params as { positionId: string };
    if (!/^[0-9a-f-]{36}$/i.test(positionId)) throw new Rejection('bad_request', 'bad position id');
    await d.agents.setGuardOverride(uid(req), aid(req), positionId, parse(GuardOverrideInput, req.body));
    return { ok: true };
  });
  app.post('/v1/agents/:id/status', { preHandler: authed }, async (req) => d.agents.setStatus(uid(req), aid(req), parse(StatusInput, req.body).action));
  app.post('/v1/agents/:id/mode', { preHandler: authed }, async (req) => {
    const { mode } = parse(ModeInput, req.body);
    // real funds: going live needs a fresh wallet signature
    if (mode === 'live') await d.auth.requireFreshSiwe(uid(req), stepUp);
    await d.agents.setMode(uid(req), aid(req), mode);
    return { mode };
  });
  app.post('/v1/agents/:id/paper/fund', { preHandler: authed }, async (req) => {
    await d.agents.fundPaper(uid(req), aid(req), parse(PaperFundInput, req.body).amount, d.setPaperBalance);
    return { ok: true };
  });
  app.get('/v1/agents/:id/decisions', { preHandler: authed }, async (req) => json(await d.agents.decisions(uid(req), aid(req), Number((req.query as { limit?: string }).limit ?? 50))));
  app.get('/v1/agents/:id/positions', { preHandler: authed }, async (req) => json(await d.agents.positions(uid(req), aid(req))));
  app.get('/v1/agents/:id/executions', { preHandler: authed }, async (req) => json(await d.agents.executions(uid(req), aid(req), Number((req.query as { limit?: string }).limit ?? 50))));

  // ── funds (architecture §6): recipient is always the owner; sensitive actions need a fresh SIWE ─────────
  app.post('/v1/agents/:id/withdraw', { preHandler: authed }, async (req) => {
    await d.agents.owned(uid(req), aid(req));
    await d.auth.requireFreshSiwe(uid(req), stepUp);
    return json(await d.funds.withdraw(aid(req), parse(WithdrawInput, req.body)));
  });
  app.get('/v1/agents/:id/withdrawals', { preHandler: authed }, async (req) => {
    await d.agents.owned(uid(req), aid(req));
    return json(await d.funds.withdrawals(aid(req)));
  });
  app.post('/v1/agents/:id/export/message', { preHandler: authed }, async (req) => {
    await d.agents.owned(uid(req), aid(req));
    await d.auth.requireFreshSiwe(uid(req), stepUp);
    return d.funds.exportMessage(aid(req));
  });
  app.post('/v1/agents/:id/export', { preHandler: authed }, async (req, reply) => {
    await d.agents.owned(uid(req), aid(req));
    await d.auth.requireFreshSiwe(uid(req), stepUp);
    const out = await d.funds.exportKey(aid(req), parse(ExportInput, req.body));
    reply.header('cache-control', 'no-store');
    return out;
  });
  app.post('/v1/agents/:id/close-all', { preHandler: authed }, async (req) => {
    const a = await d.agents.owned(uid(req), aid(req));
    return d.funds.closeAll(aid(req), a.status, a.mode, parse(CloseAllInput, req.body).mode);
  });
  app.get('/v1/agents/:id/close-requests/:requestId', { preHandler: authed }, async (req) => {
    await d.agents.owned(uid(req), aid(req));
    return json(await d.funds.closeRequest(aid(req), (req.params as { requestId: string }).requestId));
  });

  return app;
}
