import { NextResponse, type NextRequest } from 'next/server';

/**
 * Nonce-based Content-Security-Policy: only scripts carrying this request's nonce (Next.js adds it to its own
 * scripts when it sees the nonce in the request's CSP header) or loaded by them ('strict-dynamic') can run.
 * No 'unsafe-inline' for scripts, so an injected <script> or event-handler attribute does not execute.
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React style={{...}} attributes need inline styles; styles cannot run code
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  // pages only: API routes return JSON and static assets carry no inline script
  matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)' }],
};
