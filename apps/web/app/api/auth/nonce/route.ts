import { NextResponse } from 'next/server';
import { api, csrfOk } from '@/lib/server';

export async function POST(req: Request) {
  if (!csrfOk(req)) return NextResponse.json({ error: { code: 'bad_request', message: 'missing x-odin header' } }, { status: 400 });
  const r = await api('/v1/auth/nonce', { method: 'POST', body: '{}' });
  return NextResponse.json(await r.json(), { status: r.status });
}
