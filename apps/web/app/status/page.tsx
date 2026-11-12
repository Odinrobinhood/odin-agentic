'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';

type Status = {
  overall: 'operational' | 'degraded';
  services: { name: string; status: 'up' | 'down' }[];
  data: { pricesAgeSeconds: number | null; indexerAgeSeconds: number | null };
  generatedAt: string;
};

const age = (s: number | null) => (s === null ? 'no data yet' : s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

/** Public status page (no sign-in). Refreshes every 30 s. */
export default function StatusPage() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch('/api/public/status', { cache: 'no-store' })
        .then(async (r) => (r.ok ? (setS(await r.json()), setErr(null)) : setErr('Status is temporarily unavailable.')))
        .catch(() => setErr('Status is temporarily unavailable.'));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <PageHero art="/art/yggdrasil.jpg" kicker="Yggdrasil" title="System status" text="Take-profit and stop-loss run on their own service and keep guarding even if the AI is down." />
      {err && <p className="error">{err}</p>}
      {s && (
        <>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>
              {s.overall === 'operational' ? <span className="tag good">All systems operational</span> : <span className="tag bad">Some services are down</span>}
            </h2>
            <table>
              <tbody>
                {s.services.map((x) => (
                  <tr key={x.name}>
                    <td>{x.name}</td>
                    <td style={{ textAlign: 'right' }}><span className={`tag ${x.status === 'up' ? 'good' : 'bad'}`}>{x.status === 'up' ? 'up' : 'down'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Data freshness</h2>
            <table>
              <tbody>
                <tr><td>Latest market prices</td><td style={{ textAlign: 'right' }}>{age(s.data.pricesAgeSeconds)}</td></tr>
                <tr><td>Latest indexed on-chain activity</td><td style={{ textAlign: 'right' }}>{age(s.data.indexerAgeSeconds)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted">
            Checked {new Date(s.generatedAt).toLocaleString()}. If the AI agents are down, agents hold and do not trade; take-profit and stop-loss are run by the separate guard
            service and keep protecting open positions.
          </p>
        </>
      )}
    </>
  );
}
