'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { call, short } from '@/lib/client';

type Agent = { id: string; name: string; status: string; mode: string; wallet: string; created_at: string };
const statusTag = (s: string) => <span className={`tag ${s === 'active' ? 'good' : s === 'retired' ? 'bad' : 'warn'}`}>{s}</span>;

export default function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = () => call<Agent[]>('GET', '/agents').then(setAgents).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : setErr(e.message)));
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    setErr(null);
    try {
      const a = await call<{ id: string }>('POST', '/agents', { name });
      location.href = `/agents/${a.id}`;
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <h1>Agents</h1>
      <div className="panel row">
        <div style={{ flex: 1 }}>
          <label>New agent name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stock dip buyer" />
        </div>
        <button onClick={create} disabled={!name.trim()}>Create agent</button>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th>Mode</th><th>Agent wallet</th><th>Created</th></tr>
          </thead>
          <tbody>
            {agents?.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/agents/${a.id}`}>{a.name}</Link></td>
                <td>{statusTag(a.status)}</td>
                <td><span className={`tag ${a.mode === 'live' ? 'bad' : ''}`}>{a.mode}</span></td>
                <td className="mono">{short(a.wallet)}</td>
                <td className="muted">{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {agents?.length === 0 && <tr><td colSpan={5} className="muted">No agents yet. New agents start in paper mode.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
