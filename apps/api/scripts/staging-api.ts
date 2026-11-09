/**
 * Staging smoke test against the RUNNING API (127.0.0.1:7500): a fresh wallet signs in with a real SIWE
 * signature, creates an agent (wallet address derived by the real signer), configures it on the real
 * token registry (USDG quote, WETH asset), funds paper cash and activates it in paper mode.
 * Run with /etc/odin/chain.env and /etc/odin/api.env loaded.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { createPool } from '@odin/db';

const base = `http://${process.env.API_LISTEN ?? '127.0.0.1:7500'}`;
const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const show = (label: string, r: { status: number; body: unknown }) => console.log(label, r.status, JSON.stringify(r.body).slice(0, 220));

const account = privateKeyToAccount(generatePrivateKey());
const n = (await call('POST', '/v1/auth/nonce')).body;
const message = createSiweMessage({ domain: n.domain, uri: n.uri, address: account.address, chainId: n.chainId, nonce: n.nonce, version: '1' });
const login = await call('POST', '/v1/auth/verify', { message, signature: await account.signMessage({ message }) });
show('-- siwe login:', { status: login.status, body: { address: login.body.address, expiresIn: login.body.expiresIn } });
const t = login.body.accessToken as string;

const agent = await call('POST', '/v1/agents', { name: 'staging api agent' }, t);
show('-- create agent (wallet from signer):', agent);
const id = agent.body.id as string;
show('-- config v1:', await call('POST', `/v1/agents/${id}/config`, { systemPrompt: 'Hold unless WETH drops 3% in an hour.', model: 'claude-opus-5-5', quoteAsset: 'USDG', cadenceSeconds: 300, contextInputs: { candles: { period_minutes: 15, count: 16 } } }, t));
show('-- assets (real registry):', await call('PUT', `/v1/agents/${id}/assets`, { tokens: [process.env.CHAIN_WETH] }, t));
show('-- bad asset (not a token):', await call('PUT', `/v1/agents/${id}/assets`, { tokens: ['0x000000000000000000000000000000000000dead'] }, t));
show('-- tp/sl:', await call('PUT', `/v1/agents/${id}/tpsl`, { stopLoss: { mode: 'pct', value: 4 }, takeProfit: { mode: 'pct', value: 8 } }, t));
show('-- paper fund 500 USDG:', await call('POST', `/v1/agents/${id}/paper/fund`, { amount: '500' }, t));
show('-- activate:', await call('POST', `/v1/agents/${id}/status`, { action: 'activate' }, t));
show('-- agent:', await call('GET', `/v1/agents/${id}`, undefined, t));
show('-- positions:', await call('GET', `/v1/agents/${id}/positions`, undefined, t));
// ── funds ──────────────────────────────────────────────────────────────────
show('-- withdraw 1 USDG (signer sends to the owner; node refuses: no ETH for gas):', await call('POST', `/v1/agents/${id}/withdraw`, { token: process.env.CHAIN_USDG, amount: '1' }, t));

const em = await call('POST', `/v1/agents/${id}/export/message`, {}, t);
const exportSig = await account.signMessage({ message: em.body.message });
const exp = await call('POST', `/v1/agents/${id}/export`, { message: em.body.message, signature: exportSig }, t);
const derived = exp.status === 200 ? privateKeyToAccount(exp.body.privateKey).address : null;
console.log('-- export key (owner-signed):', exp.status, 'derives agent wallet:', derived === agent.body.wallet);
show('-- export replay (nonce burned by signer):', await call('POST', `/v1/agents/${id}/export`, { message: em.body.message, signature: exportSig }, t));
const stranger = privateKeyToAccount(generatePrivateKey());
const em2 = await call('POST', `/v1/agents/${id}/export/message`, {}, t);
show('-- export signed by someone else:', await call('POST', `/v1/agents/${id}/export`, { message: em2.body.message, signature: await stranger.signMessage({ message: em2.body.message }) }, t));

// close-all: give the paper agent a WETH position, queue the close, the running guard watcher executes it
const pool = createPool('postgresql://odin@/odin?host=/var/run/postgresql', { max: 1 });
await pool.query(
  `INSERT INTO positions (agent_id, token_address, mode, qty, avg_entry_price) VALUES ($1, $2, 'paper', '10000000000000000', 2000)
   ON CONFLICT (agent_id, token_address, mode) DO UPDATE SET qty = EXCLUDED.qty`,
  [id, process.env.CHAIN_WETH!.toLowerCase()],
);
const close = await call('POST', `/v1/agents/${id}/close-all`, {}, t);
show('-- close-all queued:', close);
let cr: { status: number; body: Record<string, any> } = close;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  cr = await call('GET', `/v1/agents/${id}/close-requests/${close.body.requestId}`, undefined, t);
  if (cr.body.status !== 'pending' && cr.body.status !== 'processing') break;
}
show('-- close-all result (guard watcher):', cr);
show('-- positions after close:', await call('GET', `/v1/agents/${id}/positions`, undefined, t));
await pool.end();

// leave the staging scheduler clean: this agent has no LLM key to run with
show('-- retire:', await call('POST', `/v1/agents/${id}/status`, { action: 'retire' }, t));
show('-- withdraw still allowed after retire (expect insufficient_gas, not a status error):', await call('POST', `/v1/agents/${id}/withdraw`, { token: 'native', amount: '0.0001' }, t));
show('-- no token:', await call('GET', '/v1/agents'));
