'use client';
import { createSiweMessage } from 'viem/siwe';
import { getAddress, type Address } from 'viem';

export type ApiError = { code: string; message: string };
export class ApiFailure extends Error {
  code: string;
  constructor(e: ApiError) {
    super(e.message);
    this.code = e.code;
  }
}

/** Every call goes through the same-origin proxy; tokens never reach page JavaScript. */
export async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'x-odin': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFailure(j.error ?? { code: 'internal_error', message: `HTTP ${r.status}` });
  return j as T;
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<any> };
const wallet = (): Eip1193 => {
  const w = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!w) throw new Error('No browser wallet found. Install MetaMask, Rabby or another injected wallet.');
  return w;
};

export async function connectedAddress(): Promise<Address> {
  const [a] = (await wallet().request({ method: 'eth_requestAccounts' })) as string[];
  if (!a) throw new Error('No account selected in the wallet');
  return getAddress(a);
}

/** personal_sign with the user's wallet (used for SIWE and key export). */
export async function signText(address: Address, text: string): Promise<`0x${string}`> {
  return wallet().request({ method: 'personal_sign', params: [text, address] });
}

/** Sign-In With Ethereum. Also used as step-up before withdraw / export / going live. */
export async function signIn(): Promise<Address> {
  const address = await connectedAddress();
  const n = await fetch('/api/auth/nonce', { method: 'POST', headers: { 'x-odin': '1' } }).then((r) => r.json());
  const message = createSiweMessage({
    domain: n.domain,
    uri: n.uri,
    address,
    chainId: n.chainId,
    nonce: n.nonce,
    version: '1',
    statement: 'Sign in to Odin Robinhood.',
    expirationTime: new Date(n.expiresAt),
  });
  const signature = await signText(address, message);
  const r = await fetch('/api/auth/verify', { method: 'POST', headers: { 'x-odin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) });
  const j = await r.json();
  if (!r.ok) throw new ApiFailure(j.error);
  return getAddress(j.address);
}

/** Run a sensitive call; if the API asks for step-up, re-sign in once (with the SAME account) and retry. */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'unauthorized' && /step-up/.test(e.message)) {
      const me = await call('GET', '/me').catch(() => null);
      const selected = await connectedAddress();
      if (me?.address && getAddress(me.address) !== selected) {
        throw new Error(`Your wallet has another account selected (${short(selected)}). Switch back to ${short(me.address)} to confirm.`);
      }
      await signIn();
      return fn();
    }
    throw e;
  }
}

/** Symbols/names with characters outside printable ASCII can imitate real tickers (e.g. Cyrillic 'Т' in 'ТSLA'). */
export const unusualText = (s?: string | null) => !!s && /[^\x20-\x7E]/.test(s);

/** Models this server offers (Claude + operator-allowlisted OpenRouter models), fetched once per page. */
let modelsCache: Promise<string[]> | null = null;
export function availableModels(): Promise<string[]> {
  modelsCache ??= call('GET', '/models').then((r: { id: string }[]) => r.map((m) => m.id)).catch(() => []);
  return modelsCache;
}

export const explorerTx = (hash: string) => `https://robinhoodchain.blockscout.com/tx/${hash}`;
export const explorerAddress = (a: string) => `https://robinhoodchain.blockscout.com/address/${a}`;
export const short = (a?: string | null) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? '');
export const fmt = (n: unknown, d = 2) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
export const units = (raw: string | number | null | undefined, decimals: number, d = 6) => (raw === null || raw === undefined ? '—' : fmt(Number(raw) / 10 ** decimals, d));
