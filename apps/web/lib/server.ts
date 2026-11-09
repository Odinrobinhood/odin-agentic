import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/** Backend-for-frontend helpers: tokens live only in httpOnly cookies; the browser never sees them. */
export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:7500';
const SECURE = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').startsWith('https://');
export const AT = 'odin_at';
export const RT = 'odin_rt';

export function setTokens(res: NextResponse, t: { accessToken: string; refreshToken: string; expiresIn: number }) {
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

export async function api(path: string, init: { method: string; body?: string; token?: string; ua?: string | null }) {
  return fetch(`${API_URL}${path}`, {
    method: init.method,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.ua ? { 'user-agent': init.ua } : {}),
    },
    body: init.body,
    cache: 'no-store',
  });
}
