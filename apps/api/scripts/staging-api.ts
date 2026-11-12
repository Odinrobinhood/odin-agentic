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

const models = (await call('GET', '/v1/models', undefined, t)).body as { id: string }[];
console.log('-- models offered:', JSON.stringify(models.map((m) => m.id)));
const model = models[0]!.id;
const agent = await call('POST', '/v1/agents', { name: 'staging api agent' }, t);
show('-- create agent (wallet from signer):', agent);
const id = agent.body.id as string;
show('-- config v1:', await call('POST', `/v1/agents/${id}/config`, { systemPrompt: 'Hold unless WETH drops 3% in an hour.', model, quoteAsset: 'USDG', cadenceSeconds: 300, contextInputs: { candles: { period_minutes: 15, count: 16 } } }, t));
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

// portfolio: watch the real WETH/USDG fee-100 pool (holds real balances) next to the SIWE + agent wallets
show('-- watch pool address:', await call('POST', '/v1/portfolio/watch', { address: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', label: 'WETH/USDG pool' }, t));
const pf = (await call('GET', '/v1/portfolio', undefined, t)).body;
console.log('-- portfolio:', JSON.stringify({ valueUsdg: Math.round(pf.valueUsdg), unpriced: pf.unpriced, asOfBlock: pf.asOfBlock, wallets: pf.wallets.map((w: any) => ({ kind: w.kind, valueUsdg: Math.round(w.valueUsdg), holdings: w.holdings.map((h: any) => [h.symbol, h.valueUsdg === null ? null : Math.round(h.valueUsdg), h.historyComplete]) })) }));

// signals & alerts: a price alert that must fire, wallet activity on the busy WETH/USDG pool, an AI profile
show('-- alert price_below 100000:', await call('POST', '/v1/alerts', { rule: { condition: 'price_below', token: process.env.CHAIN_WETH, price: 100000 }, channels: [], cooldownSeconds: 3600 }, t));
show('-- alert wallet_activity pool:', await call('POST', '/v1/alerts', { rule: { condition: 'wallet_activity', address: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca' }, channels: [], cooldownSeconds: 60 }, t));
show('-- bad alert (not a condition):', await call('POST', '/v1/alerts', { rule: { condition: 'buy', token: process.env.CHAIN_WETH } }, t));
show('-- signal profile:', await call('POST', '/v1/signals/profiles', { mandate: 'Flag strong 1h momentum.', model, tokens: [process.env.CHAIN_WETH], cadenceSeconds: 3600, channels: [], enabled: false }, t));
await new Promise((r) => setTimeout(r, 35_000));
const profs = (await call('GET', '/v1/signals/profiles', undefined, t)).body as unknown as { last_error: string | null; last_run_at: string | null }[];
console.log('-- signal profile run:', JSON.stringify(profs.map((p) => ({ ran: !!p.last_run_at, last_error: p.last_error }))));
const alerts = (await call('GET', '/v1/alerts', undefined, t)).body as unknown as { condition: string; last_fired_at: string | null }[];
console.log('-- alerts fired:', JSON.stringify(alerts.map((a) => [a.condition, !!a.last_fired_at])));

// notifications: the close-all above was queued as an alert; the notifier marks it delivered in-app
await call('POST', '/v1/notifications/test', {}, t);
await new Promise((r) => setTimeout(r, 5000));
const feed = (await call('GET', '/v1/notifications?limit=10', undefined, t)).body as unknown as { payload: { event: string }; delivered_channels: string[] }[];
console.log('-- notification feed:', JSON.stringify(feed.map((f) => [f.payload.event, f.delivered_channels])));
const ruleMsg = (await call('GET', '/v1/notifications?limit=20', undefined, t)).body as unknown as { payload: { event: string; condition?: string } }[];
console.log('-- rule alert notifications:', JSON.stringify(ruleMsg.filter((f) => f.payload.event === 'rule_alert').map((f) => f.payload.condition)));

// leave the staging scheduler clean: this agent has no LLM key to run with
show('-- retire:', await call('POST', `/v1/agents/${id}/status`, { action: 'retire' }, t));
show('-- withdraw still allowed after retire (expect insufficient_gas, not a status error):', await call('POST', `/v1/agents/${id}/withdraw`, { token: 'native', amount: '0.0001' }, t));
show('-- no token:', await call('GET', '/v1/agents'));
