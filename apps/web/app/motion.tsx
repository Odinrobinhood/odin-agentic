'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({ children, delay = 0, className = '', as: Tag = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: 'div' | 'section' | 'article' }) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || !('IntersectionObserver' in window)) return setShown(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} className={`reveal ${shown ? 'in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

/** Counts a number up from zero (or from its previous value) with an ease-out. */
export function CountUp({ value, format = (n) => n.toLocaleString('en-US'), duration = 1200 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(a + (value - a) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/** Green sparks drifting up behind a section (decorative). Positions are deterministic so server and client agree. */
export function Embers({ count = 18 }: { count?: number }) {
  const sparks = Array.from({ length: count }, (_, i) => {
    const r = (n: number) => ((Math.sin(i * 9301 + n * 49297) + 1) / 2);
    return { left: `${(r(1) * 100).toFixed(1)}%`, size: 2 + Math.round(r(2) * 4), dur: 9 + r(3) * 12, delay: -r(4) * 20 };
  });
  return (
    <div className="embers" aria-hidden="true">
      {sparks.map((s, i) => (
        <i key={i} style={{ left: s.left, width: s.size, height: s.size, animationDuration: `${s.dur.toFixed(1)}s`, animationDelay: `${s.delay.toFixed(1)}s` }} />
      ))}
    </div>
  );
}

export type ConsoleLine = { text: string; tone?: 'muted' | 'rune' | 'gold' | 'ember' | 'win' };

/** Types lines one by one like a live agent log, holds, then starts over. */
export function TypeConsole({ title, lines }: { title: string; lines: ConsoleLine[] }) {
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (reducedMotion()) {
      setLine(lines.length);
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    if (line >= lines.length) t = setTimeout(() => (setLine(0), setChars(0)), 4200);
    else if (chars < lines[line]!.text.length) t = setTimeout(() => setChars((c) => c + 2), 14);
    else t = setTimeout(() => (setLine((l) => l + 1), setChars(0)), 380);
    return () => clearTimeout(t);
  }, [line, chars, lines]);
  const color = { muted: 'var(--muted)', rune: 'var(--rune)', gold: 'var(--gold)', ember: 'var(--ember)', win: 'var(--rune)' } as const;
  return (
    <div className="console" style={{ borderRadius: 20, border: '1px solid rgba(70,242,155,0.45)', background: 'linear-gradient(180deg,#0a1913,#06100b)', boxShadow: '0 40px 120px -30px rgba(70,242,155,0.45)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'var(--ember)' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'var(--gold)' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'var(--rune)' }} />
        <span className="mono" style={{ marginLeft: 10, color: 'var(--muted)' }}>{title}</span>
        <span className="mono" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--rune)', fontSize: 12 }}><span className="live-dot" />LIVE</span>
      </div>
      <div className="mono" style={{ padding: '20px 22px', fontSize: 14.5, lineHeight: 1.9, minHeight: 330 }}>
        {lines.map((l, i) =>
          i < line || (i === line && chars > 0) ? (
            <div key={i} style={{ color: l.tone ? color[l.tone] : 'var(--soft)', fontWeight: l.tone === 'win' ? 700 : 400 }}>
              {i < line ? l.text : l.text.slice(0, chars)}
              {i === line && <span style={{ animation: 'caret 1s steps(1) infinite', color: 'var(--rune)' }}>▌</span>}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

type Price = { symbol: string; price: number; changePct: number | null };

/** Scrolling tape of real Robinhood Chain prices from the public API. Renders nothing until data arrives. */
export function Ticker() {
  const [prices, setPrices] = useState<Price[]>([]);
  useEffect(() => {
    const load = () => fetch('/api/public/prices').then((r) => (r.ok ? r.json() : [])).then(setPrices).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (prices.length === 0) return null;
  const item = (p: Price, k: string) => (
    <span key={k} className="mono" style={{ fontSize: 15 }}>
      {p.symbol} <b style={{ color: 'var(--text-hi)' }}>{p.price.toLocaleString('en-US', { maximumFractionDigits: p.price < 10 ? 4 : 2 })}</b>{' '}
      {p.changePct !== null && <span style={{ color: p.changePct >= 0 ? 'var(--rune)' : 'var(--ember)' }}>{p.changePct >= 0 ? '▲' : '▼'} {Math.abs(p.changePct).toFixed(2)}%</span>}
    </span>
  );
  return (
    <section aria-label="Robinhood Chain prices" style={{ borderTop: '1px solid rgba(70,242,155,0.25)', borderBottom: '1px solid rgba(70,242,155,0.25)', background: '#07120d', overflow: 'hidden' }}>
      <div style={{ display: 'flex', width: 'max-content', gap: 48, padding: '15px 0', whiteSpace: 'nowrap', animation: 'marquee 40s linear infinite' }}>
        {[...prices, ...prices].map((p, i) => item(p, `${p.symbol}-${i}`))}
      </div>
    </section>
  );
}

/** Page header: lore art behind a title, with a slow zoom and drifting embers. */
export function PageHero({ art, kicker, title, text, children }: { art: string; kicker: string; title: string; text?: string; children?: ReactNode }) {
  return (
    <section className="hero-banner" style={{ minHeight: 220 }}>
      <img className="zoomin" src={art} alt="" aria-hidden="true" />
      <Embers count={8} />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
          <span className="eyebrow">{kicker}</span>
          <h1 style={{ margin: 0, fontSize: 'clamp(34px, 5vw, 54px)' }}>{title}</h1>
          {text && <p style={{ margin: 0, color: 'var(--soft)' }}>{text}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}
