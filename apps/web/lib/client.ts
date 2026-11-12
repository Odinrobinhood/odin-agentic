'use client';
import { createSiweMessage } from 'viem/siwe';
import { getAddress, toHex, type Address } from 'viem';

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

// ── wallets ──────────────────────────────────────────────────────────────────
type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<any> };
/** A wallet found in the page: announced over EIP-6963 (several can coexist), or the legacy window.ethereum. */
export type WalletInfo = { id: string; name: string; icon?: string; provider: Eip1193 };

const REMEMBER = 'odin.wallet';
let chosen: WalletInfo | null = null;

/** Every wallet extension in this browser. Without EIP-6963, window.ethereum is the only one (and may be any brand). */
export async function discoverWallets(waitMs = 350): Promise<WalletInfo[]> {
  const found = new Map<string, WalletInfo>();
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent).detail as { info?: { rdns?: string; uuid?: string; name?: string; icon?: string }; provider?: Eip1193 } | undefined;
    if (!d?.provider || !d.info) return;
    const id = d.info.rdns || d.info.uuid || d.info.name || 'wallet';
    const icon = typeof d.info.icon === 'string' && d.info.icon.startsWith('data:image/') ? d.info.icon : undefined;
    found.set(id, { id, name: String(d.info.name ?? 'Wallet').slice(0, 40), icon, provider: d.provider });
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, waitMs));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  const legacy = (globalThis as { ethereum?: Eip1193 & { isMetaMask?: boolean; isRabby?: boolean } }).ethereum;
  if (found.size === 0 && legacy) {
    found.set('injected', { id: 'injected', name: legacy.isRabby ? 'Rabby' : legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: legacy });
  }
  return [...found.values()];
}

export function chooseWallet(w: WalletInfo) {
  chosen = w;
  try {
    localStorage.setItem(REMEMBER, w.id);
  } catch {}
}
export function rememberedWalletId(): string | null {
  try {
    return localStorage.getItem(REMEMBER);
  } catch {
    return null;
  }
}

/** The wallet chosen at sign-in (also used for step-up and key export later), else the remembered or only one. */
async function wallet(): Promise<WalletInfo> {
  if (chosen) return chosen;
  const all = await discoverWallets();
  const w = all.find((x) => x.id === rememberedWalletId()) ?? all[0];
  if (!w) throw new NoWalletError();
  chosen = w;
  return w;
}

export class NoWalletError extends Error {
  constructor() {
    super('No browser wallet found.');
  }
}

/** Wallet errors in plain words (EIP-1193 / JSON-RPC codes). */
export function walletErrorText(e: unknown, name = 'your wallet'): string {
  const err = e as { code?: number; message?: string; cause?: { code?: number } };
  const code = err?.code ?? err?.cause?.code;
  if (code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '')) return `The request was declined in ${name}. Nothing was signed.`;
  if (code === -32002) return `${name} already has a request waiting. Open ${name} from the browser toolbar, finish or close it, then try again.`;
  if (code === 4100) return `${name} is locked. Unlock it and try again.`;
  if (e instanceof ApiFailure) {
    if (e.code === 'rate_limited') return 'Too many attempts. Wait a minute and try again.';
    return `Sign-in was refused: ${e.message}. Try again; if it keeps failing, use a regular (non-smart-contract) wallet account.`;
  }
  return err?.message ? String(err.message).slice(0, 200) : 'Something went wrong with the wallet.';
}

const ROBINHOOD_CHAIN = {
  chainId: '0x1237', // 4663
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

/** Put the wallet on Robinhood Chain (adding it if unknown). Best effort: signing in does not depend on it. */
export async function ensureRobinhoodChain(): Promise<boolean> {
  const { provider } = await wallet();
  try {
    if ((await provider.request({ method: 'eth_chainId' })) === ROBINHOOD_CHAIN.chainId) return true;
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN.chainId }] });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 4902 || /unrecognized|not been added|unknown chain/i.test((e as Error).message ?? '')) {
      try {
        await provider.request({ method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN] });
        return true;
      } catch {}
    }
    return false;
  }
}

export async function connectedAddress(): Promise<Address> {
  const { provider } = await wallet();
  const [a] = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!a) throw new Error('No account selected in the wallet');
  return getAddress(a);
}

/** personal_sign with the user's wallet (used for SIWE and key export). Hex-encoded: the most compatible form. */
export async function signText(address: Address, text: string): Promise<`0x${string}`> {
  const { provider } = await wallet();
  return provider.request({ method: 'personal_sign', params: [toHex(text), address] });
}

export type SignInStep = 'connect' | 'sign' | 'verify';

/** Sign-In With Ethereum. Also used as step-up before withdraw / export / going live. */
export async function signIn(onStep?: (s: SignInStep) => void): Promise<Address> {
  onStep?.('connect');
  const address = await connectedAddress();
  // No network switch here: a chain prompt that never shows (seen on Firefox) must not block signing in.
  // ensureRobinhoodChain() is offered from the Deposit panel instead.
  const nr = await fetch('/api/auth/nonce', { method: 'POST', headers: { 'x-odin': '1' } });
  const n = await nr.json().catch(() => ({}));
  if (!nr.ok || !n.nonce) throw new ApiFailure(n.error ?? { code: 'internal_error', message: `could not start sign-in (HTTP ${nr.status})` });
  const message = createSiweMessage({
    domain: n.domain,
    uri: n.uri,
    address,
    chainId: n.chainId,
    nonce: n.nonce,
    version: '1',
    statement: 'Sign in to Odin Robinhood. This is a free signature, not a transaction.',
    expirationTime: new Date(n.expiresAt),
  });
  onStep?.('sign');
  const signature = await signText(address, message);
  onStep?.('verify');
  const r = await fetch('/api/auth/verify', { method: 'POST', headers: { 'x-odin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFailure(j.error ?? { code: 'internal_error', message: `HTTP ${r.status}` });
  return getAddress(j.address);
}

/** Anonymous connect diagnostics (wallet names, step, error code; never addresses or signatures). Best effort. */
export function reportConnect(event: Record<string, unknown>) {
  try {
    const body = JSON.stringify({ ...event, ua: navigator.userAgent.slice(0, 160) });
    fetch('/api/diag/connect', { method: 'POST', headers: { 'x-odin': '1', 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {}
}

/** Open the connect dialog (rendered once by the app shell). */
export const openConnect = () => window.dispatchEvent(new Event('odin:connect'));

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
