import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { ApproveRequest, ExportRequest, Rejection, SwapRequest, WithdrawRequest } from '@odin/shared';
import type { Channel } from './ledger.ts';
import type { Signer } from './signer.ts';

const MAX_BODY = 16 * 1024;
const WalletRequest = z.object({ derivationIndex: z.string().regex(/^[0-9]{1,18}$/) }).strict();

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Rejection('bad_request', 'body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Rejection('bad_request', 'invalid JSON');
  }
}

/**
 * One HTTP listener per channel. The channel is a property of the listener (and its token),
 * never of the request body, so the API cannot claim to be the Guard Watcher.
 */
export function createChannelServer(signer: Signer, channel: Channel, token: string, log = console): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, channel, commit: process.env.BUILD_COMMIT ?? 'dev' });
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), token)) throw new Rejection('unauthorized', 'bad token');
      if (req.method !== 'POST') throw new Rejection('bad_request', 'POST only');

      const body = await readJson(req);
      let result;
      if (req.url === '/v1/approve') {
        const parsed = ApproveRequest.safeParse(body);
        if (!parsed.success) throw new Rejection('bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        result = await signer.approve(parsed.data, channel);
      } else if (req.url === '/v1/swap') {
        const parsed = SwapRequest.safeParse(body);
        if (!parsed.success) throw new Rejection('bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        result = await signer.swap(parsed.data, channel);
      } else if (req.url === '/v1/withdraw') {
        const parsed = WithdrawRequest.safeParse(body);
        if (!parsed.success) throw new Rejection('bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        result = await signer.withdraw(parsed.data, channel);
      } else if (req.url === '/v1/export') {
        const parsed = ExportRequest.safeParse(body);
        if (!parsed.success) throw new Rejection('bad_request', 'invalid export request');
        const out = await signer.exportKey(parsed.data, channel);
        // never log the key
        log.warn(JSON.stringify({ msg: 'key exported', channel, agentId: parsed.data.agentId, address: out.address }));
        return send(res, 200, out);
      } else if (req.url === '/v1/wallet' && channel === 'agent') {
        const parsed = WalletRequest.safeParse(body);
        if (!parsed.success) throw new Rejection('bad_request', 'derivationIndex must be a non-negative integer string');
        return send(res, 200, { address: signer.addressFor(BigInt(parsed.data.derivationIndex)) });
      } else {
        return send(res, 404, { error: { code: 'bad_request', message: 'unknown route' } });
      }
      log.info(JSON.stringify({ msg: 'signed', channel, route: req.url, txHash: result.txHash, from: result.from }));
      send(res, 200, result);
    } catch (e) {
      if (e instanceof Rejection) {
        const status = e.code === 'unauthorized' ? 401 : e.code === 'bad_request' ? 400 : 422;
        log.warn(JSON.stringify({ msg: 'rejected', channel, route: req.url, code: e.code, message: e.message }));
        return send(res, status, { error: { code: e.code, message: e.message } });
      }
      log.error(JSON.stringify({ msg: 'error', channel, route: req.url, error: (e as Error).message }));
      send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
    }
  });
}

export function listen(server: Server, spec: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // "host:port" (loopback only) or a unix socket path
    const m = /^(127\.0\.0\.1|\[::1\]|localhost):(\d+)$/.exec(spec);
    if (m) server.listen(Number(m[2]), m[1]!.replace(/[[\]]/g, ''), () => resolve());
    else if (spec.startsWith('/')) server.listen(spec, () => resolve());
    else reject(new Error(`listen spec ${spec} must be a loopback host:port or a unix socket path`));
  });
}
