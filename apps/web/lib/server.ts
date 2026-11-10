import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/** Backend-for-frontend helpers: tokens live only in httpOnly cookies; the browser never sees them. */
export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:7500';
const SECURE = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').startsWith('https://');
export const AT = 'odin_at';
export const RT = 'odin_rt';
/** Same limit as the API: bodies above this are refused before the BFF buffers them. */
export const MAX_BODY = 64 * 1024;

export type TokenSet = { accessToken: string; refreshToken: string; expiresIn: number };

export function setTokens(res: NextResponse, t: TokenSet) {
  const base = { httpOnly: true, secure: SECURE, sameSite: 'strict' as const, path: '/' };
  res.cookies.set(AT, t.accessToken, { ...base, maxAge: t.expiresIn });
  res.cookies.set(RT, t.refreshToken, { ...base, path: '/api', maxAge: 30 * 86_400 });
}

export function clearTokens(res: NextResponse) {
  res.cookies.set(AT, '', { path: '/', maxAge: 0 });
  res.cookies.set(RT, '', { path: '/api', maxAge: 0 });
}

export async function readCookies() {
  const c = await cookies();
  return { at: c.get(AT)?.value, rt: c.get(RT)?.value };
}

/** State-changing calls must carry this header; with SameSite=Strict cookies this blocks cross-site requests. */
export function csrfOk(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD' || req.headers.get('x-odin') === '1';
}

/**
 * The client's address as seen by the hop in front of us (Next / the TLS proxy append the peer address last).
 * Earlier entries come from the client and are ignored, so the address cannot be spoofed past that hop.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : '127.0.0.1';
}

/** Request body as text, refusing anything over MAX_BODY without buffering it all. */
export async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export const tooLarge = () => NextResponse.json({ error: { code: 'bad_request', message: 'body too large' } }, { status: 413 });

export async function api(path: string, init: { method: string; body?: string; token?: string; from?: Request }) {
  const ua = init.from?.headers.get('user-agent');
  return fetch(`${API_URL}${path}`, {
    method: init.method,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(ua ? { 'user-agent': ua } : {}),
      // the API trusts this header only from loopback (us): per-client rate limits instead of one shared bucket
      ...(init.from ? { 'x-forwarded-for': clientIp(init.from) } : {}),
    },
    body: init.body,
    cache: 'no-store',
  });
}

/**
 * Single-flight refresh. A page fires several calls at once; if each refreshed with the same refresh token,
 * the second would look like token reuse and revoke the whole session. Concurrent (and, for 30 s, repeated)
 * refreshes of one token share one rotation and its result.
 */
const inflight = new Map<string, { at: number; p: Promise<TokenSet | null> }>();
export function refreshOnce(rt: string, from: Request): Promise<TokenSet | null> {
  const key = createHash('sha256').update(rt).digest('hex');
  const now = Date.now();
  for (const [k, v] of inflight) if (now - v.at > 30_000) inflight.delete(k);
  const hit = inflight.get(key);
  if (hit) return hit.p;
  const p = api('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }), from }).then(async (r) =>
    r.ok ? ((await r.json()) as TokenSet) : null,
  );
  inflight.set(key, { at: now, p });
  return p;
}
