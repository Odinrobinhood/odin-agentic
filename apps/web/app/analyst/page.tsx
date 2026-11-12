'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, call } from '@/lib/client';

type Msg = { role: 'user' | 'assistant'; content: string; tool_calls?: { name: string; ok: boolean }[] | null; as_of_block?: string | null };

export default function Analyst() {
  const [convs, setConvs] = useState<{ id: string; title: string }[]>([]);
  const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    call('GET', '/analyst/conversations').then(setConvs).catch((e) => (e.code === 'unauthorized' ? (location.href = '/') : null));
  }, []);
  useEffect(() => {
    if (cid) call('GET', `/analyst/conversations/${cid}`).then(setMsgs).catch(() => {});
  }, [cid]);
  // Block body on purpose: newer browsers return a Promise from scrollIntoView, which React would call as cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);
  const ask = async () => {
    setErr(null);
    setBusy(true);
    try {
      let id = cid;
      if (!id) {
        id = (await call('POST', '/analyst/conversations', { title: q.slice(0, 80) })).id as string;
        setCid(id);
        setConvs([{ id, title: q.slice(0, 80) }, ...convs]);
      }
      setMsgs((m) => [...m, { role: 'user', content: q }]);
      const question = q;
      setQ('');
      const a = await call('POST', `/analyst/conversations/${id}/messages`, { content: question });
      setMsgs((m) => [...m, { role: 'assistant', content: a.answer, tool_calls: a.toolCalls, as_of_block: a.asOfBlock }]);
    } catch (e) {
      setErr(e instanceof ApiFailure ? `${e.code}: ${e.message}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="panel" style={{ width: 240 }}>
        <button className="ghost" onClick={() => (setCid(null), setMsgs([]))}>New conversation</button>
        {convs.map((c) => (
          <div key={c.id} style={{ marginTop: 8 }}><a href="#" onClick={(e) => (e.preventDefault(), setCid(c.id))}>{c.title || 'Conversation'}</a></div>
        ))}
      </div>
      <div style={{ flex: 1 }}>
        <div className="row" style={{ gap: 16, marginBottom: 6 }}>
          <img className="lore-icon" src="/art/ravens.webp" alt="" aria-hidden="true" />
          <h1 style={{ margin: 0 }}>Market analyst</h1>
        </div>
        <p className="muted">Ask about any token on Robinhood Chain (Stock Tokens included). Answers come only from on-chain data and cite their source; this is not financial advice.</p>
        <div className="panel chat">
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
              {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                <div className="muted mono" style={{ marginTop: 6 }}>tools: {m.tool_calls.map((t) => `${t.name}${t.ok ? '' : ' (failed)'}`).join(', ')}{m.as_of_block ? ` · as of block ${m.as_of_block}` : ''}</div>
              )}
            </div>
          ))}
          {busy && <div className="bubble assistant muted">Reading the chain…</div>}
          <div ref={end} />
        </div>
        {err && <p className="error">{err}</p>}
        <div className="row">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim() && !busy && ask()} placeholder="e.g. Who has been buying WETH in the last hour?" style={{ flex: 1 }} />
          <button onClick={ask} disabled={!q.trim() || busy}>Ask</button>
        </div>
      </div>
    </div>
  );
}
