'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';
import { ApiFailure, availableModels, call, fmt, short } from '@/lib/client';

type Any = Record<string, any>;
const CONDITIONS: Record<string, { label: string; fields: [string, string][] }> = {
  price_above: { label: 'Price at or above', fields: [['token', 'Token address'], ['price', 'Price (USDG)']] },
  price_below: { label: 'Price at or below', fields: [['token', 'Token address'], ['price', 'Price (USDG)']] },
  change_pct: { label: 'Moves by % within minutes', fields: [['token', 'Token address'], ['pct', 'Change %'], ['minutes', 'Minutes']] },
  volume_above: { label: 'Swap volume above', fields: [['token', 'Token address'], ['amount', 'Tokens'], ['minutes', 'Minutes']] },
  liquidity_below: { label: 'Pool liquidity below', fields: [['pool', 'Pool address'], ['liquidity', 'Liquidity (raw)']] },
  large_transfer: { label: 'Large transfer', fields: [['token', 'Token address'], ['amount', 'Min tokens']] },
  wallet_activity: { label: 'Wallet activity', fields: [['address', 'Wallet address']] },
};
const NUMERIC = new Set(['price', 'pct', 'minutes', 'amount']);

export default function Alerts() {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    availableModels().then(setModels);
  }, []);
  const [alerts, setAlerts] = useState<Any[]>([]);
  const [profiles, setProfiles] = useState<Any[]>([]);
  const [signals, setSignals] = useState<Any[]>([]);
  const [cond, setCond] = useState('price_below');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [cooldown, setCooldown] = useState('3600');
  const [prof, setProf] = useState({ mandate: '', model: '', tokens: '', cadenceSeconds: '3600' });
  useEffect(() => {
    if (!prof.model && models[0]) setProf((p) => ({ ...p, model: models[0]! }));
  }, [models, prof.model]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    call('GET', '/alerts').then(setAlerts).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : null));
    call('GET', '/signals/profiles').then(setProfiles).catch(() => {});
    call('GET', '/signals?limit=50').then(setSignals).catch(() => {});
  };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiFailure ? `${e.code}: ${e.message}` : (e as Error).message });
    }
  };
  const createAlert = () =>
    run(() => call('POST', '/alerts', {
      rule: { condition: cond, ...Object.fromEntries(CONDITIONS[cond]!.fields.map(([k]) => [k, NUMERIC.has(k) ? Number(fields[k]) : fields[k] ?? ''])) },
      cooldownSeconds: Number(cooldown),
    }), 'Alert created');
  const createProfile = () =>
    run(() => call('POST', '/signals/profiles', { mandate: prof.mandate, model: prof.model, tokens: prof.tokens.split(/[\s,]+/).filter(Boolean), cadenceSeconds: Number(prof.cadenceSeconds) }), 'Signal profile created');
  return (
    <>
      <PageHero art="/art/ravens.jpg" kicker="Huginn &amp; Muninn" title="Signals & alerts" text="Huginn thinks: AI signals on your schedule. Muninn remembers: rule alerts the moment a line is crossed. Neither ever trades." />
      <p className="muted">Information only — alerts and signals never place trades.</p>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <h2>Rule alerts</h2>
      <div className="panel">
        <div className="grid">
          <div><label>Condition</label><select value={cond} onChange={(e) => (setCond(e.target.value), setFields({}))}>{Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
          {CONDITIONS[cond]!.fields.map(([k, l]) => <div key={k}><label>{l}</label><input value={fields[k] ?? ''} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} /></div>)}
          <div><label>Cooldown (s)</label><input value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>
        </div>
        <button onClick={createAlert} style={{ marginTop: 12 }}>Create alert</button>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Condition</th><th>Params</th><th>Last fired</th><th>On</th><th /></tr></thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td>{CONDITIONS[a.condition]?.label ?? a.condition}</td>
                <td className="mono">{Object.entries(a.params).map(([k, v]) => `${k}=${typeof v === 'string' && v.startsWith('0x') ? short(v) : v}`).join(' ')}</td>
                <td className="muted">{a.last_fired_at ? new Date(a.last_fired_at).toLocaleString() : 'never'}</td>
                <td><input type="checkbox" checked={a.enabled} onChange={(e) => run(() => call('PATCH', `/alerts/${a.id}`, { enabled: e.target.checked }), 'Updated')} style={{ width: 'auto' }} /></td>
                <td><button className="ghost" onClick={() => run(() => call('DELETE', `/alerts/${a.id}`), 'Deleted')}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>AI signal profiles</h2>
      <div className="panel">
        <label>Signal mandate</label>
        <textarea value={prof.mandate} onChange={(e) => setProf({ ...prof, mandate: e.target.value })} placeholder="e.g. Flag strong 1-hour momentum and liquidity drains." />
        <div className="grid" style={{ marginTop: 12 }}>
          <div><label>Model</label><select value={prof.model} onChange={(e) => setProf({ ...prof, model: e.target.value })}>{models.map((m) => <option key={m}>{m}</option>)}</select></div>
          <div><label>Watched token addresses (comma separated)</label><input value={prof.tokens} onChange={(e) => setProf({ ...prof, tokens: e.target.value })} /></div>
          <div><label>Cadence (s, min 300)</label><input value={prof.cadenceSeconds} onChange={(e) => setProf({ ...prof, cadenceSeconds: e.target.value })} /></div>
        </div>
        <button onClick={createProfile} style={{ marginTop: 12 }}>Create profile</button>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Mandate</th><th>Model</th><th>Tokens</th><th>Next run</th><th>Last error</th></tr></thead>
          <tbody>{profiles.map((p) => <tr key={p.id}><td>{p.mandate.slice(0, 80)}</td><td>{p.model}</td><td className="mono">{p.tokens.map(short).join(', ')}</td><td className="muted">{p.next_run_at ? new Date(p.next_run_at).toLocaleString() : '—'}</td><td>{p.last_error && <span className="tag bad">{p.last_error.slice(0, 60)}</span>}</td></tr>)}</tbody>
        </table>
      </div>
      <h2>Latest signals</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Token</th><th>Direction</th><th>Confidence</th><th>Rationale</th></tr></thead>
          <tbody>
            {signals.map((s) => <tr key={s.id}><td className="muted">{new Date(s.created_at).toLocaleString()}</td><td className="mono">{short(s.token_address)}</td><td><span className={`tag ${s.direction === 'bullish' ? 'good' : s.direction === 'bearish' ? 'bad' : ''}`}>{s.direction}</span></td><td>{fmt(Number(s.confidence) * 100, 0)}%</td><td>{s.rationale}</td></tr>)}
            {signals.length === 0 && <tr><td colSpan={5} className="muted">No signals yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
