'use client';
import { useState } from 'react';
import { signIn } from '@/lib/client';

export default function Home() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await signIn();
      location.href = '/agents';
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ maxWidth: 560, margin: '48px auto' }}>
      <h1>Odin Agentic</h1>
      <p className="muted">
        AI trading agents, a market analyst, signals and a portfolio tracker for Robinhood Chain. Your agents trade only with your rules; take-profit and stop-loss are yours and the AI cannot change them.
      </p>
      <p className="muted">Sign in with your wallet. You sign a message; nothing is sent on-chain and no funds move.</p>
      <button onClick={go} disabled={busy}>{busy ? 'Waiting for wallet…' : 'Connect wallet & sign in'}</button>
      {err && <p className="error">{err}</p>}
      <div className="warnbox">Markets move and agents can be wrong. You can lose the funds you deposit.</div>
    </div>
  );
}
