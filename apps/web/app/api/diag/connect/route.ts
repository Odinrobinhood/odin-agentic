import { clientIp } from '@/lib/server';

/**
 * Anonymous wallet-connect diagnostics: which step failed and with which wallet error. Logged to the odin-web
 * journal only (`journalctl -u odin-web | grep connect-diag`). Only whitelisted short fields are kept; no
 * addresses, messages to sign or signatures are ever sent by the client. Per-IP limited.
 */
const hits = new Map<string, { n: number; reset: number }>();
const FIELDS = ['result', 'step', 'wallet', 'wallets', 'legacy', 'code', 'message', 'ua'] as const;

export async function POST(req: Request) {
  if (req.headers.get('x-odin') !== '1') return new Response(null, { status: 403 });
  const ip = clientIp(req);
  const now = Date.now();
  const h = hits.get(ip);
  if (h && h.reset > now && h.n >= 30) return new Response(null, { status: 429 });
  hits.set(ip, h && h.reset > now ? { n: h.n + 1, reset: h.reset } : { n: 1, reset: now + 60_000 });
  if (hits.size > 5000) hits.clear();
  const text = await req.text();
  if (text.length > 2000) return new Response(null, { status: 413 });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const out: Record<string, string> = {};
  for (const k of FIELDS) if (body[k] !== undefined && body[k] !== null) out[k] = String(body[k]).replace(/0x[0-9a-fA-F]{40}/g, '0x…').slice(0, 200);
  console.log(JSON.stringify({ msg: 'connect-diag', ip: ip.replace(/\.\d+$/, '.x'), ...out }));
  return new Response(null, { status: 204 });
}
