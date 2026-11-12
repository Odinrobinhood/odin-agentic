'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chooseWallet, discoverWallets, rememberedWalletId, signIn, walletErrorText, type SignInStep, type WalletInfo } from '@/lib/client';

const STEPS: [SignInStep, string, string][] = [
  ['connect', 'Connect', 'Approve the connection in your wallet.'],
  ['network', 'Robinhood Chain', 'Allow switching to (or adding) Robinhood Chain. You can skip this.'],
  ['sign', 'Sign in', 'Sign the message. It is free and is not a transaction.'],
  ['verify', 'Verify', 'Checking the signature…'],
];

type State =
  | { kind: 'closed' }
  | { kind: 'finding' }
  | { kind: 'pick'; wallets: WalletInfo[] }
  | { kind: 'working'; wallet: WalletInfo; step: SignInStep; slow: boolean }
  | { kind: 'error'; wallet?: WalletInfo; text: string; wallets: WalletInfo[] }
  | { kind: 'none' };

const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * The one sign-in dialog. Opened by any "Connect" button through openConnect() (a window event), so the top bar and
 * the landing page share the same flow: find wallets (EIP-6963) → pick → connect → network → sign → verify.
 */
export default function ConnectDialog({ onSignedIn }: { onSignedIn: () => void }) {
  const [s, setS] = useState<State>({ kind: 'closed' });
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (w: WalletInfo, all: WalletInfo[]) => {
      chooseWallet(w);
      const set = (step: SignInStep) => {
        if (slowTimer.current) clearTimeout(slowTimer.current);
        setS({ kind: 'working', wallet: w, step, slow: false });
        if (step !== 'verify') slowTimer.current = setTimeout(() => setS((x) => (x.kind === 'working' && x.step === step ? { ...x, slow: true } : x)), 12_000);
      };
      try {
        await signIn(set);
        if (slowTimer.current) clearTimeout(slowTimer.current);
        setS({ kind: 'closed' });
        onSignedIn();
      } catch (e) {
        if (slowTimer.current) clearTimeout(slowTimer.current);
        setS({ kind: 'error', wallet: w, text: walletErrorText(e, w.name), wallets: all });
      }
    },
    [onSignedIn],
  );

  const open = useCallback(async () => {
    setS({ kind: 'finding' });
    const all = await discoverWallets();
    if (all.length === 0) return setS({ kind: 'none' });
    const remembered = all.find((w) => w.id === rememberedWalletId());
    if (all.length === 1) return run(all[0]!, all);
    if (remembered && all.length > 1) return setS({ kind: 'pick', wallets: [remembered, ...all.filter((w) => w !== remembered)] });
    setS({ kind: 'pick', wallets: all });
  }, [run]);

  useEffect(() => {
    const h = () => void open();
    window.addEventListener('odin:connect', h);
    return () => window.removeEventListener('odin:connect', h);
  }, [open]);
  useEffect(() => {
    if (s.kind === 'closed') return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && s.kind !== 'working' && setS({ kind: 'closed' });
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [s.kind]);

  if (s.kind === 'closed') return null;
  const close = () => setS({ kind: 'closed' });
  const here = typeof location !== 'undefined' ? `${location.host}${location.pathname}` : 'odinrobinhood.com';

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && s.kind !== 'working' && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="kicker" id="connect-title">connect / wallet</span>
          <button className="quiet" onClick={close} aria-label="Close">close</button>
        </div>

        {s.kind === 'finding' && <p className="muted">Looking for wallets in this browser…</p>}

        {s.kind === 'pick' && (
          <>
            <h2 style={{ margin: '6px 0 4px' }}>Choose a wallet</h2>
            <p className="muted" style={{ marginTop: 0 }}>Several wallets are installed. Pick the one that holds the account you want to use.</p>
            <div className="wallet-list">
              {s.wallets.map((w, i) => (
                <button key={w.id} className="ghost wallet-item" onClick={() => run(w, s.wallets)}>
                  {w.icon ? <img src={w.icon} alt="" /> : <span className="wallet-dot" />}
                  <span>{w.name}</span>
                  {i === 0 && w.id === rememberedWalletId() && <span className="tag">last used</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {s.kind === 'working' && (
          <>
            <h2 style={{ margin: '6px 0 14px' }}>Continue in {s.wallet.name}</h2>
            <ol className="connect-steps">
              {STEPS.map(([k, t, d]) => {
                const idx = STEPS.findIndex(([x]) => x === s.step);
                const me = STEPS.findIndex(([x]) => x === k);
                return (
                  <li key={k} className={me < idx ? 'done' : me === idx ? 'now' : ''}>
                    <strong>{t}</strong>
                    {me === idx && <span>{d}</span>}
                  </li>
                );
              })}
            </ol>
            {s.slow && (
              <p className="warnbox" style={{ marginBottom: 0 }}>
                Nothing showed up? Click the {s.wallet.name} icon in your browser toolbar — the request may be waiting there. If it is locked, unlock it first.
              </p>
            )}
          </>
        )}

        {s.kind === 'error' && (
          <>
            <h2 style={{ margin: '6px 0 6px' }}>Not signed in</h2>
            <p className="error" style={{ marginTop: 0 }}>{s.text}</p>
            <div className="row">
              {s.wallet && <button className="arrow" onClick={() => run(s.wallet!, s.wallets)}>Try again</button>}
              {s.wallets.length > 1 && <button className="ghost" onClick={() => setS({ kind: 'pick', wallets: s.wallets })}>Use another wallet</button>}
            </div>
          </>
        )}

        {s.kind === 'none' && (
          <>
            <h2 style={{ margin: '6px 0 6px' }}>No wallet in this browser</h2>
            {isPhone() ? (
              <>
                <p className="muted" style={{ marginTop: 0 }}>On a phone, open this page inside your wallet app&apos;s browser.</p>
                <div className="row">
                  <a className="button-link arrow" href={`https://metamask.app.link/dapp/${here}`}>Open in MetaMask</a>
                </div>
                <p className="muted" style={{ fontSize: 13 }}>Other wallets: open the app, find its built-in browser and go to {here.split('/')[0]}.</p>
              </>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>Install a browser wallet extension, create or import an account, then reload this page.</p>
                <div className="row">
                  <a className="button-link arrow" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask</a>
                  <a className="btn-link" href="https://rabby.io/" target="_blank" rel="noreferrer">Rabby</a>
                </div>
              </>
            )}
            <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Use a fresh account for trading; never paste a private key or seed phrase into any website.</p>
          </>
        )}
      </div>
    </div>
  );
}

