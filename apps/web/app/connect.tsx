'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chooseWallet, discoverWallets, rememberedWalletId, reportConnect, signIn, walletErrorText, type SignInStep, type WalletInfo } from '@/lib/client';

const STEPS: [SignInStep, string, string][] = [
  ['connect', 'Connect', 'Approve the connection in your wallet.'],
  ['sign', 'Sign in', 'Sign the message. It is free and is not a transaction.'],
  ['verify', 'Verify', 'Checking the signature…'],
];

type State =
  | { kind: 'closed' }
  | { kind: 'finding' }
  | { kind: 'pick'; wallets: WalletInfo[] }
  | { kind: 'working'; wallet: WalletInfo; step: SignInStep; slow: boolean; pending?: boolean; wallets: WalletInfo[] }
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
  const attempt = useRef(0); // a newer attempt (e.g. 'use another wallet') makes older wallet promises stale

  const run = useCallback(
    async (w: WalletInfo, all: WalletInfo[]) => {
      chooseWallet(w);
      const me = ++attempt.current;
      const live = () => attempt.current === me;
      let at: SignInStep = 'connect';
      const set = (step: SignInStep) => {
        at = step;
        if (slowTimer.current) clearTimeout(slowTimer.current);
        if (!live()) return;
        setS({ kind: 'working', wallet: w, step, slow: false, wallets: all });
        if (step !== 'verify') slowTimer.current = setTimeout(() => (reportConnect({ result: 'slow', step, wallet: w.name }), setS((x) => (x.kind === 'working' && x.step === step ? { ...x, slow: true } : x))), 12_000);
      };
      try {
        await signIn(set, () => {
          if (!live()) return;
          if (slowTimer.current) clearTimeout(slowTimer.current);
          reportConnect({ result: 'pending', wallet: w.name });
          setS({ kind: 'working', wallet: w, step: 'connect', slow: false, pending: true, wallets: all });
        });
        if (!live()) return;
        if (slowTimer.current) clearTimeout(slowTimer.current);
        reportConnect({ result: 'ok', wallet: w.name, wallets: all.length });
        setS({ kind: 'closed' });
        onSignedIn();
      } catch (e) {
        if (slowTimer.current) clearTimeout(slowTimer.current);
        if (!live()) return;
        const x = e as { code?: unknown; message?: unknown };
        reportConnect({ result: 'error', step: at, wallet: w.name, wallets: all.length, code: x?.code ?? null, message: String(x?.message ?? e).slice(0, 200) });
        setS({ kind: 'error', wallet: w, text: walletErrorText(e, w.name), wallets: all });
      }
    },
    [onSignedIn],
  );

  const open = useCallback(async () => {
    setS({ kind: 'finding' });
    const all = await discoverWallets();
    const legacy = !!(globalThis as { ethereum?: unknown }).ethereum;
    reportConnect({ result: 'opened', wallets: all.map((w) => w.name).join(', ') || '(none)', legacy });
    if (all.length === 0) return setS({ kind: 'none' });
    const remembered = all.find((w) => w.id === rememberedWalletId());
    if (all.length === 1) return run(all[0]!, all);
    if (remembered) return run(remembered, all); // last-used wallet: no picker; 'Use another wallet' is one click away
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
            {s.pending && (
              <p className="warnbox" style={{ marginBottom: 0 }}>
                <b>{s.wallet.name} already has a connection request open.</b> Click the {s.wallet.name} icon in your browser toolbar (top right; it may sit under the puzzle-piece menu) and press <b>Connect</b>. Sign-in continues here automatically.
              </p>
            )}
            {s.slow && !s.pending && (
              <p className="warnbox" style={{ marginBottom: 0 }}>
                Nothing showed up? Click the {s.wallet.name} icon in your browser toolbar — the request may be waiting there. If it is locked, unlock it first.
              </p>
            )}
            {s.wallets.length > 1 && (
              <button className="quiet" style={{ marginTop: 10 }} onClick={() => (attempt.current++, setS({ kind: 'pick', wallets: s.wallets }))}>Use another wallet</button>
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

