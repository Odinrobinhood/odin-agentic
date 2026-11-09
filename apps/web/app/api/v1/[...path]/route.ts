import { NextResponse } from 'next/server';
import { api, clearTokens, csrfOk, readCookies, setTokens } from '@/lib/server';

/**
 * Authenticated proxy to the API. Adds the bearer from the httpOnly cookie, refreshes it once on 401
 * (rotating the refresh token), and forwards the API's status and rejection codes unchanged.
 */
async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!csrfOk(req)) return NextResponse.json({ error: { code: 'bad_request', message: 'missing x-odin header' } }, { status: 400 });
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p.includes('/'))) return NextResponse.json({ error: { code: 'bad_request', message: 'bad path' } }, { status: 400 });
  const url = new URL(req.url);
  const target = `/v1/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.text();
  const ua = req.headers.get('user-agent');
  let { at, rt } = await readCookies();
  let refreshed: { accessToken: string; refreshToken: string; expiresIn: number } | null = null;

  let r = at ? await api(target, { method: req.method, body, token: at, ua }) : null;
  if ((!r || r.status === 401) && rt) {
    const rr = await api('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }), ua });
    if (rr.ok) {
      refreshed = await rr.json();
      at = refreshed!.accessToken;
      r = await api(target, { method: req.method, body, token: at, ua });
    }
  }
  if (!r) {
    const res = NextResponse.json({ error: { code: 'unauthorized', message: 'sign in' } }, { status: 401 });
    clearTokens(res);
    return res;
  }
  const res = new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  if (refreshed) setTokens(res, refreshed);
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
