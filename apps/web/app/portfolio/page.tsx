'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';
import { call, explorerAddress, fmt, short, units, unusualText } from '@/lib/client';

type Any = Record<string, any>;

export default function Portfolio() {
  const [p, setP] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const load = () => call('GET', '/portfolio').then(setP).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : setErr(e.message)));
  useEffect(() => {
    load();
  }, []);
  const watch = async () => {
    try {
      await call('POST', '/portfolio/watch', { address: addr, ...(label ? { label } : {}) });
      setAddr('');
      setLabel('');
      setP(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const unwatch = async (a: string) => {
    await call('DELETE', `/portfolio/watch/${a}`);
    setP(null);
    load();
  };
  return (
    <>
      <PageHero art="/art/seat.jpg" icon="/art/seat.webp" kicker="Hliðskjálf" title="Portfolio" text="Every realm from one seat — valued at what you could truly sell for." />
      <div className="panel row">
        <div style={{ flex: 2 }}><label>Watch a wallet on Robinhood Chain (read-only)</label><input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" /></div>
        <div style={{ flex: 1 }}><label>Label</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <button onClick={watch} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr)}>Watch</button>
      </div>
      {err && <p className="error">{err}</p>}
      {!p ? (
        <p className="muted">Loading balances from the chain…</p>
      ) : (
        <>
          <div className="panel grid">
            <div><label>Total value (USDG, realizable)</label><div style={{ fontSize: 22 }}>{fmt(p.valueUsdg)}</div></div>
            <div><label>Unpriced holdings</label>{p.unpriced}</div>
            <div><label>As of block</label><span className="mono">{p.asOfBlock}</span></div>
          </div>
          {p.wallets.map((w: Any) => (
            <div className="panel" key={w.address}>
              <div className="row">
                <b>{w.label ?? w.kind}</b><span className="tag">{w.kind}</span>
                <a className="mono" href={explorerAddress(w.address)} target="_blank" rel="noreferrer">{short(w.address)}</a>
                <span style={{ flex: 1 }} />
                <span>{fmt(w.valueUsdg)} USDG</span>
                {w.kind === 'watch' && <button className="ghost" onClick={() => unwatch(w.address)}>Remove</button>}
              </div>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Token</th><th>Qty</th><th>Value (USDG)</th><th>Cost basis</th><th>Unrealized PnL</th><th>Realized PnL</th></tr></thead>
                <tbody>
                  {w.holdings.map((h: Any) => (
                    <tr key={h.token}>
                      <td>
                        {h.symbol} {unusualText(h.symbol) && <span className="tag warn">unusual characters</span>}
                        <div className="mono muted"><a href={explorerAddress(h.token)} target="_blank" rel="noreferrer">{short(h.token)}</a></div>
                      </td>
                      <td>{units(h.qty, h.decimals)}</td>
                      <td>{h.priced ? fmt(h.valueUsdg) : <span className="tag warn">unpriced</span>}</td>
                      <td>{h.costBasisUsdg === null ? <span className="muted" title="Indexed history does not explain the whole balance">unknown</span> : fmt(h.costBasisUsdg)}</td>
                      <td>{h.unrealizedPnlUsdg === null ? '—' : <span style={{ color: h.unrealizedPnlUsdg >= 0 ? 'var(--good)' : 'var(--bad)' }}>{fmt(h.unrealizedPnlUsdg)}</span>}</td>
                      <td>{h.realizedPnlUsdg === null ? '—' : fmt(h.realizedPnlUsdg)}</td>
                    </tr>
                  ))}
                  {w.holdings.length === 0 && <tr><td colSpan={6} className="muted">No holdings.</td></tr>}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </>
  );
}
