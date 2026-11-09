import { NextResponse } from 'next/server';
import { api, clearTokens, csrfOk, readCookies } from '@/lib/server';

export async function POST(req: Request) {
  if (!csrfOk(req)) return NextResponse.json({ error: { code: 'bad_request', message: 'missing x-odin header' } }, { status: 400 });
  const all = new URL(req.url).searchParams.get('all') === '1';
  const { at } = await readCookies();
  if (at) await api(all ? '/v1/auth/logout-all' : '/v1/auth/logout', { method: 'POST', body: '{}', token: at }).catch(() => {});
  const res = NextResponse.json({ ok: true });
  clearTokens(res);
  return res;
}
