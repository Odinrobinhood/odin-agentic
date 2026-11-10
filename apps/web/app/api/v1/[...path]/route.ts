import { NextResponse } from 'next/server';
import { api, clearTokens, csrfOk, readBody, readCookies, refreshOnce, setTokens, tooLarge, type TokenSet } from '@/lib/server';

/**
 * Authenticated proxy to the API. Adds the bearer from the httpOnly cookie, refreshes it once on 401
 * (single-flight rotation of the refresh token), and forwards the API's status and rejection codes unchanged.
 */
async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!csrfOk(req)) return NextResponse.json({ error: { code: 'bad_request', message: 'missing x-odin header' } }, { status: 400 });
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p === '.' || p.includes('/'))) return NextResponse.json({ error: { code: 'bad_request', message: 'bad path' } }, { status: 400 });
  let { at, rt } = await readCookies();
  const unauthorized = () => {
    const res = NextResponse.json({ error: { code: 'unauthorized', message: 'sign in' } }, { status: 401 });
    clearTokens(res);
    return res;
  };
  // nothing is buffered for anonymous callers
  if (!at && !rt) return unauthorized();
  const url = new URL(req.url);
  const target = `/v1/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
  if (body === null) return tooLarge();
  let refreshed: TokenSet | null = null;

  let r = at ? await api(target, { method: req.method, body, token: at, from: req }) : null;
  if ((!r || r.status === 401) && rt) {
    refreshed = await refreshOnce(rt, req);
    if (refreshed) {
      at = refreshed.accessToken;
      r = await api(target, { method: req.method, body, token: at, from: req });
    }
  }
  if (!r) return unauthorized();
  const res = new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  if (refreshed) setTokens(res, refreshed);
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
