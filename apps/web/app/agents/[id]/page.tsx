'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { ApiFailure, call, connectedAddress, explorerAddress, explorerTx, fmt, short, signText, units, withStepUp } from '@/lib/client';

type Any = Record<string, any>;
const TABS = ['Overview', 'Strategy', 'Assets', 'Risk & TP/SL', 'Backtest', 'Activity', 'Funds'] as const;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function useMsg() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText = 'Saved') => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiFailure ? `${e.code}: ${e.message}` : (e as Error).message });
    }
  };
  const view = msg ? <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p> : null;
  return { run, view };
}

export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [agent, setAgent] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => call('GET', `/agents/${id}`).then(setAgent).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : setErr(e.message))), [id]);
  useEffect(() => {
    reload();
  }, [reload]);
  if (err) return <p className="error">{err}</p>;
  if (!agent) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>
        {agent.name} <span className={`tag ${agent.status === 'active' ? 'good' : 'warn'}`}>{agent.status}</span>{' '}
        <span className={`tag ${agent.mode === 'live' ? 'bad' : ''}`}>{agent.mode}</span>
      </h1>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Overview' && <Overview id={id} agent={agent} reload={reload} />}
      {tab === 'Strategy' && <Strategy id={id} agent={agent} reload={reload} />}
      {tab === 'Assets' && <Assets id={id} agent={agent} reload={reload} />}
      {tab === 'Risk & TP/SL' && <RiskTpSl id={id} agent={agent} reload={reload} />}
      {tab === 'Backtest' && <Backtest id={id} />}
      {tab === 'Activity' && <Activity id={id} />}
      {tab === 'Funds' && <Funds id={id} agent={agent} />}
    </>
  );
}

function Overview({ id, agent, reload }: { id: string; agent: Any; reload: () => void }) {
  const [positions, setPositions] = useState<Any[]>([]);
  const { run, view } = useMsg();
  const load = useCallback(() => call('GET', `/agents/${id}/positions`).then(setPositions).catch(() => {}), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const status = (action: string) => run(async () => (await call('POST', `/agents/${id}/status`, { action }), reload()), `Agent ${action}d`);
  const mode = (m: string) => run(async () => (await withStepUp(() => call('POST', `/agents/${id}/mode`, { mode: m })), reload()), `Mode set to ${m}`);
  const closeAll = () =>
    run(async () => {
      const r = await call('POST', `/agents/${id}/close-all`, {});
      for (let i = 0; i < 30; i++) {
        await new Promise((x) => setTimeout(x, 1500));
        const s = await call('GET', `/agents/${id}/close-requests/${r.requestId}`);
        if (s.status === 'done' || s.status === 'partial') {
          load();
          const failed = (s.result?.tokens ?? []).filter((t: Any) => !t.ok);
          if (failed.length) throw new Error(`Not closed: ${failed.map((t: Any) => `${short(t.token)} (${t.code})`).join(', ')} — you can retry`);
          return;
        }
      }
      throw new Error('Close request is still pending; check again shortly');
    }, 'All positions closed');
  const editGuard = (positionId: string, type: 'stopLoss' | 'takeProfit', value: string, gm: string) =>
    run(async () => (await call('PUT', `/agents/${id}/positions/${positionId}/guards`, { [type]: value === '' ? null : { mode: gm, value: Number(value) } }), load()));
  return (
    <>
      <div className="panel grid">
        <div><label>Agent wallet (deposit address)</label><a className="mono" href={explorerAddress(agent.wallet)} target="_blank" rel="noreferrer">{agent.wallet}</a></div>
        <div><label>Quote asset</label>{agent.config ? <span className="mono">{short(agent.config.quote_asset)}</span> : <span className="muted">set a strategy first</span>}</div>
        <div><label>Config version</label>{agent.config?.version ?? '—'}</div>
      </div>
      <div className="panel">
        <div className="row">
          {agent.status === 'draft' && <button onClick={() => status('activate')}>Activate</button>}
          {agent.status === 'active' && <button className="ghost" onClick={() => status('pause')}>Pause</button>}
          {agent.status === 'paused' && <button onClick={() => status('resume')}>Resume</button>}
          {agent.status !== 'retired' && <button className="danger" onClick={() => confirm('Retire this agent? It cannot be resumed; TP/SL stop.') && status('retire')}>Retire</button>}
          <span className="spacer" style={{ flex: 1 }} />
          {agent.mode === 'paper' ? (
            <button className="danger" onClick={() => confirm('Switch to LIVE trading with real funds in the agent wallet?') && mode('live')}>Go live</button>
          ) : (
            <button className="ghost" onClick={() => mode('paper')}>Back to paper</button>
          )}
          {(agent.status === 'active' || agent.status === 'paused') && <button className="ghost" onClick={() => confirm('Sell every open position into the quote asset?') && closeAll()}>Close all positions</button>}
        </div>
        {view}
      </div>
      <h2>Positions</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Token</th><th>Mode</th><th>Qty</th><th>Avg entry</th><th>Price (USDG)</th><th>Stop loss</th><th>Take profit</th></tr></thead>
          <tbody>
            {positions.map((p) => {
              const g = (t: string) => p.guards.find((x: Any) => x.type === t);
              return (
                <tr key={p.id}>
                  <td>{p.symbol} <span className="mono muted">{short(p.token_address)}</span></td>
                  <td>{p.mode}</td>
                  <td>{units(p.qty, p.decimals)}</td>
                  <td>{fmt(p.avg_entry_price, 4)}</td>
                  <td>{fmt(p.price_usdg, 4)}</td>
                  {(['stop_loss', 'take_profit'] as const).map((t) => (
                    <td key={t}>
                      {g(t) ? <span>{fmt(g(t).trigger, 4)} <span className="muted">({g(t).mode} {fmt(g(t).value)}, {g(t).setBy})</span>{g(t).lastRejection && <span className="tag bad">{g(t).lastRejection}</span>}</span> : <span className="muted">off</span>}
                      <GuardEdit onSave={(v, m) => editGuard(p.id, t === 'stop_loss' ? 'stopLoss' : 'takeProfit', v, m)} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {positions.length === 0 && <tr><td colSpan={7} className="muted">No open positions.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GuardEdit({ onSave }: { onSave: (value: string, mode: string) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [m, setM] = useState('pct');
  if (!open) return <div><button className="ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setOpen(true)}>edit</button></div>;
  return (
    <div className="row" style={{ marginTop: 4 }}>
      <select value={m} onChange={(e) => setM(e.target.value)} style={{ width: 80 }}><option value="pct">%</option><option value="price">price</option></select>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="empty = off" style={{ width: 100 }} />
      <button style={{ padding: '4px 8px' }} onClick={() => (onSave(v, m), setOpen(false))}>ok</button>
    </div>
  );
}

function Strategy({ id, agent, reload }: { id: string; agent: Any; reload: () => void }) {
  const c = agent.config ?? {};
  const [f, setF] = useState({
    systemPrompt: c.system_prompt ?? '',
    model: c.model_name ?? MODELS[0],
    quoteAsset: c.quote_symbol === 'WETH' ? 'WETH' : 'USDG',
    cadenceSeconds: c.cadence_seconds ?? 300,
    maxTokens: c.max_tokens ?? 16000,
    candlesPeriod: c.context_inputs?.candles?.period_minutes ?? 15,
    candlesCount: c.context_inputs?.candles?.count ?? 16,
    history: c.context_inputs?.history ?? 5,
  });
  const [triggers, setTriggers] = useState<Any[]>(c.triggers ?? []);
  const [versions, setVersions] = useState<Any[]>([]);
  const { run, view } = useMsg();
  useEffect(() => {
    call('GET', `/agents/${id}/configs`).then(setVersions).catch(() => {});
  }, [id]);
  const save = () =>
    run(async () => {
      await call('POST', `/agents/${id}/config`, {
        systemPrompt: f.systemPrompt, model: f.model, quoteAsset: f.quoteAsset, cadenceSeconds: Number(f.cadenceSeconds), maxTokens: Number(f.maxTokens),
        contextInputs: { candles: { period_minutes: Number(f.candlesPeriod), count: Number(f.candlesCount) }, history: Number(f.history) },
        triggers,
      });
      reload();
      setVersions(await call('GET', `/agents/${id}/configs`));
    }, 'New version saved');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="panel">
        <label>Strategy / mandate (your rules — the AI follows these)</label>
        <textarea value={f.systemPrompt} onChange={set('systemPrompt')} placeholder="e.g. Buy TSLA stock token on dips of 3% within a day; take profit gradually; never hold more than two tokens." />
        <div className="grid" style={{ marginTop: 12 }}>
          <div><label>Model</label><select value={f.model} onChange={set('model')}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select></div>
          <div><label>Quote asset (base)</label><select value={f.quoteAsset} onChange={set('quoteAsset')}><option>USDG</option><option value="WETH">ETH (WETH)</option></select></div>
          <div><label>Cadence (seconds, min 60)</label><input type="number" min={60} value={f.cadenceSeconds} onChange={set('cadenceSeconds')} /></div>
          <div><label>Max output tokens</label><input type="number" value={f.maxTokens} onChange={set('maxTokens')} /></div>
          <div><label>Candle period (min)</label><input type="number" value={f.candlesPeriod} onChange={set('candlesPeriod')} /></div>
          <div><label>Candle count</label><input type="number" value={f.candlesCount} onChange={set('candlesCount')} /></div>
          <div><label>Past decisions in context</label><input type="number" value={f.history} onChange={set('history')} /></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}><button onClick={save}>Save as new version</button></div>
        {view}
      </div>
      <h2>Price triggers (wake the agent early)</h2>
      <Triggers value={triggers} onChange={setTriggers} />
      <h2>Versions</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Version</th><th>Model</th><th>Cadence</th><th>Created</th><th /></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td><td>{v.model_name}</td><td>{v.cadence_seconds}s</td><td className="muted">{new Date(v.created_at).toLocaleString()}</td>
                <td><button className="ghost" onClick={() => run(async () => (await call('POST', `/agents/${id}/config/rollback`, { version: v.version }), reload(), setVersions(await call('GET', `/agents/${id}/configs`))), `Rolled back to v${v.version}`)}>Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const TRIGGERS: Record<string, { label: string; fields: [string, string][] }> = {
  price_above: { label: 'Price at or above', fields: [['price', 'Price (USDG)']] },
  price_below: { label: 'Price at or below', fields: [['price', 'Price (USDG)']] },
  change_pct: { label: 'Moves by % within minutes', fields: [['pct', 'Change %'], ['minutes', 'Minutes']] },
  volume_above: { label: 'Swap volume above', fields: [['amount', 'Tokens'], ['minutes', 'Minutes']] },
};

/** Triggers are saved with the strategy (new version). Each wakes the agent once when its condition starts to hold. */
function Triggers({ value, onChange }: { value: Any[]; onChange: (v: Any[]) => void }) {
  const [cond, setCond] = useState('price_below');
  const [token, setToken] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const add = () => {
    onChange([...value, { condition: cond, token, ...Object.fromEntries(TRIGGERS[cond]!.fields.map(([k]) => [k, Number(vals[k])])) }]);
    setVals({});
  };
  return (
    <div className="panel">
      <table>
        <tbody>
          {value.map((t, i) => (
            <tr key={i}>
              <td>{TRIGGERS[t.condition]?.label ?? t.condition}</td>
              <td className="mono">{short(t.token)}</td>
              <td>{TRIGGERS[t.condition]?.fields.map(([k]) => `${k}=${t[k]}`).join(' ')}</td>
              <td><button className="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</button></td>
            </tr>
          ))}
          {value.length === 0 && <tr><td className="muted">No triggers: the agent runs on its cadence only.</td></tr>}
        </tbody>
      </table>
      <div className="grid" style={{ marginTop: 12 }}>
        <div><label>Condition</label><select value={cond} onChange={(e) => (setCond(e.target.value), setVals({}))}>{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
        <div><label>Token address</label><input value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" /></div>
        {TRIGGERS[cond]!.fields.map(([k, l]) => <div key={k}><label>{l}</label><input value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></div>)}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={add} disabled={!/^0x[0-9a-fA-F]{40}$/.test(token) || TRIGGERS[cond]!.fields.some(([k]) => !(Number(vals[k]) > 0))}>Add trigger</button>
        <span className="muted">Saved with “Save as new version”.</span>
      </div>
    </div>
  );
}

function Assets({ id, agent, reload }: { id: string; agent: Any; reload: () => void }) {
  const [addr, setAddr] = useState('');
  const { run, view } = useMsg();
  const current: string[] = agent.assets.map((a: Any) => a.address);
  const put = (tokens: string[]) => run(async () => (await call('PUT', `/agents/${id}/assets`, { tokens }), reload(), setAddr('')));
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Any[]>([]);
  useEffect(() => {
    const t = setTimeout(() => call('GET', `/tokens?q=${encodeURIComponent(q)}&limit=25`).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const lc = current.map((a) => a.toLowerCase());
  return (
    <>
      <div className="panel">
        <label>Find any token on Robinhood Chain — by symbol, name or contract address. You decide what the agent may trade.</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. TSLA, meme, 0x…" />
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Symbol</th><th>Name</th><th>Address</th><th>Depth (USDG)</th><th /></tr></thead>
          <tbody>
            {hits.map((t) => (
              <tr key={t.address}>
                <td>
                  {t.symbol || <span className="muted">?</span>} {t.is_stock_token && <span className="tag">stock</span>}
                  {t.symbol_shadowed && <span className="tag warn" title="Another, deeper token uses the same symbol. Check the address.">same symbol as a bigger token</span>}
                </td>
                <td>{t.name}</td>
                <td className="mono"><a href={explorerAddress(t.address)} target="_blank" rel="noreferrer">{short(t.address)}</a></td>
                <td>{t.tradable ? fmt(t.depth_usdg, 0) : <span className="tag bad" title="No pool against USDG or WETH, so the agent cannot route a trade">no USDG/WETH pool</span>}</td>
                <td>{lc.includes(t.address.toLowerCase()) ? <span className="muted">added</span> : <button className="ghost" disabled={!t.tradable} onClick={() => put([...current, t.address])}>Add</button>}</td>
              </tr>
            ))}
            {hits.length === 0 && <tr><td colSpan={5} className="muted">{q ? 'No match. You can still paste any contract address below.' : 'The catalog is filled from every pool created on Robinhood Chain.'}</td></tr>}
          </tbody>
        </table>
        <label style={{ marginTop: 12 }}>Or paste a contract address</label>
        <div className="row"><input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" style={{ flex: 1 }} /><button onClick={() => put([...current, addr])} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr)}>Add</button></div>
        <p className="muted">Tokens are identified by address only — symbols and names can be copied by anyone.</p>
        {view}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Symbol</th><th>Name</th><th>Address</th><th>Stock Token</th><th /></tr></thead>
          <tbody>
            {agent.assets.map((a: Any) => (
              <tr key={a.address}>
                <td>{a.symbol}</td><td>{a.name}</td><td className="mono"><a href={explorerAddress(a.address)} target="_blank" rel="noreferrer">{a.address}</a></td>
                <td>{a.is_stock_token ? 'yes' : 'no'}</td>
                <td><button className="ghost" onClick={() => put(current.filter((x) => x !== a.address))}>Remove</button></td>
              </tr>
            ))}
            {agent.assets.length === 0 && <tr><td colSpan={5} className="muted">No assets yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RiskTpSl({ id, agent, reload }: { id: string; agent: Any; reload: () => void }) {
  const r = agent.risk ?? {};
  const t = agent.tpSl ?? {};
  const [risk, setRisk] = useState({ maxPositionPct: r.max_position_pct ?? '', maxExposurePct: r.max_exposure_pct ?? '', maxDailyLossPct: r.max_daily_loss_pct ?? '', maxTradesPerDay: r.max_trades_per_day ?? '', maxSlippageBps: r.max_slippage_bps ?? '' });
  const [tp, setTp] = useState({ slMode: t.sl_mode ?? 'pct', sl: t.sl_enabled ? t.sl_value : '', tpMode: t.tp_mode ?? 'pct', tp: t.tp_enabled ? t.tp_value : '', dev: t.deviation_timeout_seconds ?? 300 });
  const { run, view } = useMsg();
  const num = (v: unknown) => (v === '' || v === null ? null : Number(v));
  const saveRisk = () => run(async () => (await call('PUT', `/agents/${id}/risk`, Object.fromEntries(Object.entries(risk).map(([k, v]) => [k, num(v)]))), reload()));
  const saveTp = () =>
    run(async () => (await call('PUT', `/agents/${id}/tpsl`, {
      stopLoss: tp.sl === '' ? null : { mode: tp.slMode, value: Number(tp.sl) },
      takeProfit: tp.tp === '' ? null : { mode: tp.tpMode, value: Number(tp.tp) },
      deviationTimeoutSeconds: Number(tp.dev),
    }), reload()));
  const rf = (k: keyof typeof risk) => <input value={risk[k] as string} onChange={(e) => setRisk({ ...risk, [k]: e.target.value })} placeholder="off" />;
  return (
    <>
      <h2>Take profit / stop loss (default for new positions)</h2>
      <div className="panel">
        <div className="grid">
          <div><label>Stop loss</label><div className="row"><select value={tp.slMode} onChange={(e) => setTp({ ...tp, slMode: e.target.value })} style={{ width: 90 }}><option value="pct">% below</option><option value="price">price</option></select><input value={tp.sl} onChange={(e) => setTp({ ...tp, sl: e.target.value })} placeholder="off" style={{ flex: 1 }} /></div></div>
          <div><label>Take profit</label><div className="row"><select value={tp.tpMode} onChange={(e) => setTp({ ...tp, tpMode: e.target.value })} style={{ width: 90 }}><option value="pct">% above</option><option value="price">price</option></select><input value={tp.tp} onChange={(e) => setTp({ ...tp, tp: e.target.value })} placeholder="off" style={{ flex: 1 }} /></div></div>
          <div><label>Sell anyway after price deviation for (s, 0 = immediately)</label><input type="number" value={tp.dev} onChange={(e) => setTp({ ...tp, dev: e.target.value })} /></div>
        </div>
        <p className="muted">The AI cannot change these. They keep running while the agent is paused.</p>
        <button onClick={saveTp}>Save TP/SL</button>
      </div>
      <h2>Optional limits (empty = off)</h2>
      <div className="panel">
        <div className="grid">
          <div><label>Max position (% of NAV)</label>{rf('maxPositionPct')}</div>
          <div><label>Max exposure (% of NAV)</label>{rf('maxExposurePct')}</div>
          <div><label>Max daily loss (%)</label>{rf('maxDailyLossPct')}</div>
          <div><label>Max trades per day</label>{rf('maxTradesPerDay')}</div>
          <div><label>Max slippage (bps)</label>{rf('maxSlippageBps')}</div>
        </div>
        <button onClick={saveRisk} style={{ marginTop: 12 }}>Save limits</button>
      </div>
      {view}
    </>
  );
}

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function Backtest({ id }: { id: string }) {
  const [form, setForm] = useState({ from: localInput(new Date(Date.now() - 6 * 3600_000)), to: localInput(new Date()), capital: '1000' });
  const [runs, setRuns] = useState<Any[]>([]);
  const [open, setOpen] = useState<Any | null>(null);
  const { run, view } = useMsg();
  const load = useCallback(() => call('GET', `/agents/${id}/backtests`).then(setRuns).catch(() => {}), [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const start = () =>
    run(async () => {
      const r = await call('POST', `/agents/${id}/backtests`, { from: new Date(form.from).toISOString(), to: new Date(form.to).toISOString(), initialCapital: Number(form.capital) });
      load();
      return r;
    }, 'Backtest queued');
  const res = open?.result;
  return (
    <>
      <div className="panel">
        <p className="muted">Replays the latest strategy version against recorded prices. Every tick is one model call (it uses your daily AI budget). Fills use recorded prices plus the pool fee; price impact is not modelled.</p>
        <div className="grid">
          <div><label>From</label><input type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></div>
          <div><label>To</label><input type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></div>
          <div><label>Starting capital (quote)</label><input value={form.capital} onChange={(e) => setForm({ ...form, capital: e.target.value })} /></div>
        </div>
        <button onClick={start} style={{ marginTop: 12 }}>Run backtest</button>
        {view}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>Created</th><th>Version</th><th>Window</th><th>Status</th><th>Return</th><th>Max drawdown</th><th /></tr></thead>
          <tbody>
            {runs.map((b) => (
              <tr key={b.id}>
                <td className="muted">{new Date(b.created_at).toLocaleString()}</td>
                <td>v{b.config_version}</td>
                <td className="muted">{new Date(b.from_ts).toLocaleString()} → {new Date(b.to_ts).toLocaleString()}</td>
                <td><span className={`tag ${b.status === 'done' ? 'good' : b.status === 'failed' ? 'bad' : 'warn'}`}>{b.status}{b.status === 'running' ? ` ${b.progress}%` : ''}</span>{b.error && <div className="error">{b.error}</div>}</td>
                <td>{b.return_pct === null ? '—' : `${fmt(b.return_pct)}%`}</td>
                <td>{b.max_drawdown_pct === null ? '—' : `${fmt(b.max_drawdown_pct)}%`}</td>
                <td>{b.status === 'done' && <button className="ghost" onClick={() => call('GET', `/agents/${id}/backtests/${b.id}`).then(setOpen)}>View</button>}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={7} className="muted">No backtests yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {res && (
        <div className="panel">
          <div className="grid">
            <div><label>Final NAV</label>{fmt(res.finalNav, 4)}</div>
            <div><label>Return</label>{fmt(res.returnPct)}%</div>
            <div><label>Max drawdown</label>{fmt(res.maxDrawdownPct)}%</div>
            <div><label>Decisions</label>{res.decisions.buy} buy · {res.decisions.sell} sell · {res.decisions.hold} hold · {res.decisions.rejected} rejected</div>
            <div><label>AI tokens used</label>{fmt(res.tokensUsed, 0)}</div>
          </div>
          <Equity points={res.equity} />
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Time</th><th>Origin</th><th>Action</th><th>Token</th><th>Qty</th><th>Price</th><th>Quote</th></tr></thead>
            <tbody>{res.trades.map((t: Any, i: number) => <tr key={i}><td className="muted">{new Date(t.ts).toLocaleString()}</td><td>{t.origin}</td><td>{t.action}</td><td className="mono">{short(t.token)}</td><td>{fmt(t.qty, 6)}</td><td>{fmt(t.price, 4)}</td><td>{fmt(t.quoteAmount, 4)}</td></tr>)}</tbody>
          </table>
          <ul className="muted">{res.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
    </>
  );
}

function Equity({ points }: { points: { ts: string; nav: number }[] }) {
  if (points.length < 2) return null;
  const w = 800;
  const h = 160;
  const vals = points.map((p) => p.nav);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const y = (v: number) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * (h - 10) - 5);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * w).toFixed(1)},${y(p.nav).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 160, marginTop: 12 }} role="img" aria-label="Equity curve">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <text x="4" y="12" fill="var(--muted)" fontSize="11">{fmt(hi, 2)}</text>
      <text x="4" y={h - 4} fill="var(--muted)" fontSize="11">{fmt(lo, 2)}</text>
    </svg>
  );
}

function Activity({ id }: { id: string }) {
  const [d, setD] = useState<Any[]>([]);
  const [x, setX] = useState<Any[]>([]);
  useEffect(() => {
    call('GET', `/agents/${id}/decisions?limit=100`).then(setD).catch(() => {});
    call('GET', `/agents/${id}/executions?limit=100`).then(setX).catch(() => {});
  }, [id]);
  return (
    <>
      <h2>Decisions</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Origin</th><th>Action</th><th>Token</th><th>Rationale / thesis</th><th>Result</th></tr></thead>
          <tbody>
            {d.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.origin}{r.mode === 'paper' && <span className="tag">paper</span>}</td>
                <td>{r.action}{r.size && <div className="muted">{r.size.type === 'quote_amount' ? `${r.size.value} quote` : `${Number(r.size.value) * 100}% of position`}</div>}</td>
                <td className="mono">{short(r.token_address)}</td>
                <td style={{ maxWidth: 380 }}>{r.rationale}{r.thesis && <div className="muted">Thesis: {r.thesis.claim} — invalid if {r.thesis.invalidated_if}</div>}{r.confidence !== null && <div className="muted">confidence {fmt(r.confidence)}</div>}</td>
                <td>{r.rejection_code ? <span className="tag bad" title={r.rejection_message}>{r.rejection_code}</span> : r.paper_out ? <span className="tag good">paper fill</span> : r.action === 'hold' ? <span className="muted">hold</span> : null}</td>
              </tr>
            ))}
            {d.length === 0 && <tr><td colSpan={6} className="muted">No decisions yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <h2>Transactions</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Time</th><th>Kind</th><th>Status</th><th>Tx</th><th>Error</th></tr></thead>
          <tbody>
            {x.map((r) => (
              <tr key={r.tx_hash}>
                <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.kind} <span className="muted">({r.channel})</span></td>
                <td><span className={`tag ${r.status === 'confirmed' ? 'good' : r.status === 'broadcast' || r.status === 'signed' ? 'warn' : 'bad'}`}>{r.status}</span></td>
                <td className="mono">{r.status === 'confirmed' || r.status === 'reverted' ? <a href={explorerTx(r.tx_hash)} target="_blank" rel="noreferrer">{short(r.tx_hash)}</a> : short(r.tx_hash)}</td>
                <td>{r.error_code && <span className="tag bad">{r.error_code}</span>}</td>
              </tr>
            ))}
            {x.length === 0 && <tr><td colSpan={5} className="muted">No on-chain transactions yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Funds({ id, agent }: { id: string; agent: Any }) {
  const [w, setW] = useState({ token: 'native', amount: '' });
  const [paper, setPaper] = useState('1000');
  const [key, setKey] = useState<string | null>(null);
  const [list, setList] = useState<Any[]>([]);
  const { run, view } = useMsg();
  const load = useCallback(() => call('GET', `/agents/${id}/withdrawals`).then(setList).catch(() => {}), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const withdraw = () =>
    run(async () => {
      const r = await withStepUp(() => call('POST', `/agents/${id}/withdraw`, w));
      load();
      if (r.error) throw new Error(`${r.status}: ${r.error.code} — ${r.error.message}`);
    }, 'Withdrawal confirmed');
  const exportKey = () =>
    run(async () => {
      if (!confirm('Exporting reveals the private key. Anyone with it controls this wallet and its funds. Continue?')) return;
      const m = await withStepUp(() => call('POST', `/agents/${id}/export/message`, {}));
      const signature = await signText(await connectedAddress(), m.message);
      const r = await call('POST', `/agents/${id}/export`, { message: m.message, signature });
      setKey(r.privateKey);
    }, 'Key exported');
  return (
    <>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Deposit</h2>
        <p>Send funds on <b>Robinhood Chain</b> to the agent wallet:</p>
        <p className="mono">{agent.wallet}</p>
        <p className="muted">Deposit trading capital in the agent&apos;s base asset (USDG, or WETH for an ETH agent) plus a little native ETH for gas. Native ETH is used for gas only.</p>
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Withdraw (always to your signed-in wallet)</h2>
        <div className="grid">
          <div><label>Token</label><input value={w.token} onChange={(e) => setW({ ...w, token: e.target.value })} placeholder="native or 0x… token address" /></div>
          <div><label>Amount</label><input value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} placeholder="e.g. 25.5" /></div>
        </div>
        <button onClick={withdraw} style={{ marginTop: 12 }} disabled={!w.amount}>Withdraw</button>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Time</th><th>Token</th><th>Amount (raw)</th><th>Status</th><th>Tx</th></tr></thead>
          <tbody>{list.map((x) => <tr key={x.id}><td className="muted">{new Date(x.created_at).toLocaleString()}</td><td className="mono">{x.token ? short(x.token) : 'ETH'}</td><td>{x.amount}</td><td><span className={`tag ${x.status === 'confirmed' ? 'good' : 'bad'}`}>{x.status}</span>{x.error_code && <span className="tag bad">{x.error_code}</span>}</td><td className="mono">{x.tx_hash && x.status === 'confirmed' ? <a href={explorerTx(x.tx_hash)} target="_blank" rel="noreferrer">{short(x.tx_hash)}</a> : short(x.tx_hash)}</td></tr>)}</tbody>
        </table>
      </div>
      {agent.mode === 'paper' && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Paper balance</h2>
          <div className="row"><input value={paper} onChange={(e) => setPaper(e.target.value)} style={{ width: 160 }} /><button onClick={() => run(() => call('POST', `/agents/${id}/paper/fund`, { amount: paper }), 'Paper balance set')}>Set paper cash</button></div>
        </div>
      )}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Export private key</h2>
        <p className="muted">Requires your wallet signature; the signing service verifies it itself.</p>
        <button className="danger" onClick={exportKey}>Export key</button>
        {key && <div className="warnbox"><div>Shown once. Store it safely:</div><div className="mono" style={{ wordBreak: 'break-all' }}>{key}</div></div>}
      </div>
      {view}
    </>
  );
}
