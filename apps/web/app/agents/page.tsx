'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { call, short } from '@/lib/client';
import { Embers } from '../motion';

type Agent = { id: string; name: string; status: string; mode: string; wallet: string; created_at: string };
const ART = ['/art/shield.jpg', '/art/gungnir.jpg', '/art/knot.jpg', '/art/eye.jpg', '/art/ravens.jpg', '/art/seat.jpg', '/art/yggdrasil.jpg'];
const art = (id: string) => ART[parseInt(id.replace(/-/g, '').slice(-6), 16) % ART.length]!;

function StatusPill({ status }: { status: string }) {
  if (status === 'active') return <span className="tag good"><span className="live-dot" style={{ width: 6, height: 6 }} />active</span>;
  return <span className={`tag ${status === 'retired' ? 'bad' : 'warn'}`}>{status}</span>;
}

export default function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => call<Agent[]>('GET', '/agents').then(setAgents).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : setErr(e.message)));
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      const a = await call<{ id: string }>('POST', '/agents', { name });
      location.href = `/agents/${a.id}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const active = agents?.filter((a) => a.status !== 'retired') ?? [];
  const retired = agents?.filter((a) => a.status === 'retired') ?? [];
  return (
    <>
      <section className="hero-banner" style={{ minHeight: 260 }}>
        <img className="zoomin" src="/art/yggdrasil.jpg" alt="" aria-hidden="true" />
        <Embers count={10} />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
            <span className="eyebrow">Einherjar</span>
            <h1 style={{ margin: 0, fontSize: 'clamp(36px, 5vw, 56px)' }}>Your agents</h1>
            <p style={{ margin: 0, color: 'var(--soft)' }}>Each one has its own wallet and follows only the runes you carve. New agents start in paper mode.</p>
          </div>
          <form className="row" style={{ gap: 10, flex: '0 1 460px' }} onSubmit={(e) => (e.preventDefault(), name.trim() && create())}>
            <div style={{ flex: '1 1 240px' }}>
              <label htmlFor="new-agent">Name a new warrior</label>
              <input id="new-agent" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stock dip buyer" />
            </div>
            <button className="arrow" type="submit" disabled={!name.trim() || busy} style={{ alignSelf: 'flex-end', minHeight: 44 }}>{busy ? 'Creating…' : 'Create agent'}</button>
          </form>
        </div>
      </section>
      {err && <p className="error">{err}</p>}

      {agents === null && (
        <div className="grid">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 230 }} />)}
        </div>
      )}

      {agents !== null && active.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', padding: 48 }}>
          <img src="/art/medal.webp" alt="" aria-hidden="true" className="medal-big" style={{ width: 160, height: 160 }} />
          <h2 style={{ marginTop: 18 }}>No warriors yet</h2>
          <p className="muted">Name one above. It starts in paper mode — real prices, simulated money.</p>
        </div>
      )}

      <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 18 }}>
        {active.map((a) => (
          <Link key={a.id} href={`/agents/${a.id}`} className="card lift" style={{ padding: 0, overflow: 'hidden', color: 'var(--text)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ position: 'relative', height: 130, overflow: 'hidden' }}>
              <img className="art" src={art(a.id)} alt="" aria-hidden="true" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, rgba(7,16,12,1) 0%, transparent 70%)' }} />
            </div>
            <div style={{ padding: '4px 20px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 22, color: 'var(--text-hi)' }}>{a.name}</strong>
              <div className="row" style={{ gap: 8 }}>
                <StatusPill status={a.status} />
                <span className={`tag ${a.mode === 'live' ? 'bad' : 'warn'}`}>{a.mode}</span>
              </div>
              <span className="mono muted">{short(a.wallet)} · since {new Date(a.created_at).toLocaleDateString()}</span>
            </div>
          </Link>
        ))}
      </div>

      {retired.length > 0 && (
        <details style={{ marginTop: 28 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>Retired agents ({retired.length})</summary>
          <div className="panel" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Name</th><th>Wallet</th><th>Created</th></tr></thead>
              <tbody>
                {retired.map((a) => (
                  <tr key={a.id}>
                    <td><Link href={`/agents/${a.id}`}>{a.name}</Link></td>
                    <td className="mono">{short(a.wallet)}</td>
                    <td className="muted">{new Date(a.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
