import { NextResponse } from 'next/server';
import { api } from '@/lib/server';

/** Public, read-only API data (no account): only these names are reachable. */
const ALLOWED = new Set(['status', 'codes', 'prices']);

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!ALLOWED.has(name)) return NextResponse.json({ error: { code: 'bad_request', message: 'unknown' } }, { status: 404 });
  const r = await api(`/v1/public/${name}`, { method: 'GET', from: req });
  return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
