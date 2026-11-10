import { NextResponse } from 'next/server';
import { api, csrfOk, readBody, setTokens, tooLarge } from '@/lib/server';

/** SIWE verify: tokens go straight into httpOnly cookies; only the address is returned to the page. */
export async function POST(req: Request) {
  if (!csrfOk(req)) return NextResponse.json({ error: { code: 'bad_request', message: 'missing x-odin header' } }, { status: 400 });
  const body0 = await readBody(req);
  if (body0 === null) return tooLarge();
  const r = await api('/v1/auth/verify', { method: 'POST', body: body0, from: req });
  const body = await r.json();
  if (!r.ok) return NextResponse.json(body, { status: r.status });
  const res = NextResponse.json({ address: body.address });
  setTokens(res, body);
  return res;
}
