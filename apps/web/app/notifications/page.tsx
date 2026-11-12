'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';
import { ApiFailure, call, short } from '@/lib/client';

type Any = Record<string, any>;

const describe = (p: Any) => {
  switch (p.event) {
    case 'guard_fired': return `${p.type === 'stop_loss' ? 'Stop loss' : 'Take profit'} executed on ${short(p.token)} at ${Number(p.price).toFixed(4)}`;
    case 'guard_exit_failed': return `${p.type === 'stop_loss' ? 'Stop loss' : 'Take profit'} on ${short(p.token)} could not execute: ${p.code} (stays armed)`;
    case 'close_all': return `Close all positions: ${p.status}`;
    case 'trade_executed': return `Trade ${p.action} ${short(p.token)}${p.mode === 'paper' ? ' (paper)' : ''}`;
    case 'agent_paused': return `Agent paused after repeated errors`;
    case 'rule_alert': return `Alert: ${p.condition} ${short(p.spec?.token ?? p.spec?.pool ?? p.spec?.address)}`;
    case 'ai_signal': return `AI signal: ${short(p.token)} ${p.direction} (${Math.round(Number(p.confidence) * 100)}%)`;
    case 'test': return 'Test notification';
    default: return p.event ?? 'event';
  }
};

export default function Notifications() {
  const [feed, setFeed] = useState<Any[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    call('GET', '/notifications?limit=100').then(setFeed).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : null));
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
  return (
    <>
      <PageHero art="/art/eye.jpg" icon="/art/medal.webp" kicker="Messages from the ravens" title="Notifications" text="Trades, take-profit and stop-loss exits, failed exits, low gas, alerts and signals." />
      <div className="panel row">
        <p className="muted" style={{ flex: 1, margin: 0 }}>Alerts, signals, trades and TP/SL exits appear here (in-app only).</p>
        <button className="ghost" onClick={() => run(() => call('POST', '/notifications/test', {}), 'Test queued')}>Send test</button>
      </div>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Delivered</th></tr></thead>
          <tbody>
            {feed.map((n) => (
              <tr key={n.id}>
                <td className="muted">{new Date(n.created_at).toLocaleString()}</td>
                <td>{describe(n.payload)}</td>
                <td>{(n.delivered_channels ?? []).join(', ')}{n.last_error && <span className="tag warn" title={n.last_error}>!</span>}</td>
              </tr>
            ))}
            {feed.length === 0 && <tr><td colSpan={3} className="muted">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
