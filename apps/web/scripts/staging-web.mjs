// Staging check of the web app's backend-for-frontend, against the running services:
// SIWE login through /api/auth (tokens land in httpOnly cookies), authenticated proxy calls,
// CSRF header enforcement, security headers. Run from apps/web with node.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const base = 'http://127.0.0.1:3000';
let cookie = '';
const req = async (method, path, body, headers = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  return { status: r.status, headers: r.headers, set, body: await r.text() };
};

const home = await req('GET', '/');
console.log('-- GET / :', home.status, '| CSP:', !!home.headers.get('content-security-policy'), '| X-Frame-Options:', home.headers.get('x-frame-options'));
console.log('-- POST nonce without x-odin (CSRF):', (await req('POST', '/api/auth/nonce')).status);

const account = privateKeyToAccount(generatePrivateKey());
const n = JSON.parse((await req('POST', '/api/auth/nonce', undefined, { 'x-odin': '1' })).body);
const message = createSiweMessage({ domain: n.domain, uri: n.uri, address: account.address, chainId: n.chainId, nonce: n.nonce, version: '1' });
const v = await req('POST', '/api/auth/verify', { message, signature: await account.signMessage({ message }) }, { 'x-odin': '1' });
console.log('-- SIWE verify via BFF:', v.status, v.body, '| cookies httpOnly+SameSite=Strict:', v.set.every((c) => /HttpOnly/i.test(c) && /SameSite=Strict/i.test(c)));
console.log('-- tokens never in the response body:', !/accessToken|refreshToken/.test(v.body));

const agents = await req('GET', '/api/v1/agents');
console.log('-- GET /api/v1/agents with cookie:', agents.status, agents.body);
const created = await req('POST', '/api/v1/agents', { name: 'web smoke' }, { 'x-odin': '1' });
console.log('-- create agent via proxy:', created.status, created.body.slice(0, 160));
console.log('-- POST via proxy without x-odin (CSRF):', (await req('POST', '/api/v1/agents', { name: 'x' })).status);
const id = JSON.parse(created.body).id;
console.log('-- retire smoke agent:', (await req('POST', `/api/v1/agents/${id}/status`, { action: 'retire' }, { 'x-odin': '1' })).status);
await req('POST', '/api/auth/logout', undefined, { 'x-odin': '1' });
cookie = '';
console.log('-- after logout:', (await req('GET', '/api/v1/agents')).status);
