'use client';
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { call, signIn } from '@/lib/client';
import { CountUp, Embers, Reveal, Ticker, TypeConsole, type ConsoleLine } from './motion';

const CONSOLE: ConsoleLine[] = [
  { text: '› read 6 hourly candles · WETH, NVDA', tone: 'muted' },
  { text: '› WETH: two up-closes in a row ✓ entry rule met' },
  { text: 'thesis   upside momentum continues for 3 hours', tone: 'gold' },
  { text: 'wrong if an hourly candle closes > 1.5% below its open', tone: 'gold' },
  { text: 'intent   BUY WETH · 200 USDG', tone: 'rune' },
  { text: '› risk engine · balance ✓ limits ✓ Chainlink referee ✓' },
  { text: '› signer · own quote ✓ deepest pool ✓ router pinned ✓' },
  { text: '✦ FILLED · 200 USDG → WETH at the on-chain quote', tone: 'win' },
  { text: 'valkyries armed · stop-loss −5% · take-profit +8%', tone: 'gold' },
];

const PANTHEON = [
  { art: '/art/shield.jpg', kicker: 'EINHERJAR · TRADING AGENTS', title: 'Warriors that only follow your runes', text: 'Each agent has its own wallet, wakes on your schedule or on a price trigger, and writes down every decision with its reasoning. Paper first, live when you say so.', wide: true },
  { art: null, kicker: 'VALKYRIES · TAKE-PROFIT & STOP-LOSS', title: 'They answer to you, not the AI', text: 'Checked every few seconds at the price you could actually sell at — even while the agent sleeps.' },
  { art: '/art/gungnir.jpg', kicker: 'GUNGNIR · THE SIGNER', title: 'Strikes only where allowed', text: 'Isolated keys, one pinned router, the agent’s own wallet as the only destination.' },
  { art: '/art/eye.jpg', kicker: 'MÍMIR · MARKET ANALYST', title: 'Ask the well anything', text: 'Answers from on-chain tools only, every number cited with its block.' },
  { art: '/art/ravens.jpg', kicker: 'HUGINN & MUNINN · SIGNALS', title: 'Two ravens, always flying', text: 'AI signals on your schedule and rule alerts the moment a line is crossed. They inform; they never trade.' },
  { art: '/art/seat.jpg', kicker: 'HLIÐSKJÁLF · PORTFOLIO', title: 'See every realm from one seat', text: 'Your wallet, your agents and any address you watch, valued at what you could truly sell for. Unknown shows as unknown, never zero.', wide: true },
];

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    call('GET', '/me').then(() => setSignedIn(true)).catch(() => setSignedIn(false));
  }, []);
  const go = async () => {
    if (signedIn) return void (location.href = '/agents');
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
  const ctaLabel = busy ? 'Waiting for your wallet…' : signedIn ? 'Open your agents' : 'Summon your first agent';

  return (
    <div style={{ overflow: 'hidden' }}>
      {/* ── hero ── */}
      <section style={{ position: 'relative', minHeight: 'min(900px, 100vh)', display: 'flex', alignItems: 'center' }}>
        <img className="zoomin" src="/art/yggdrasil.jpg" alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.42 }} />
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(60% 70% at 72% 50%, rgba(70,242,155,0.22), transparent 60%), linear-gradient(180deg, rgba(5,10,8,0.2) 0%, rgba(5,10,8,0.65) 70%, #050A08 100%)' }} />
        <Embers count={22} />
        <div className="row" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 1280, margin: '0 auto', padding: '64px 24px 96px', gap: 48, alignItems: 'center' }}>
          <div className="stagger" style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 26 }}>
            <span className="tag good" style={{ alignSelf: 'flex-start', padding: '7px 16px', fontFamily: 'var(--font-mono)', letterSpacing: '0.1em' }}><span className="live-dot" />LIVE ON ROBINHOOD CHAIN · 4663</span>
            <h1 style={{ margin: 0, fontSize: 'clamp(54px, 8vw, 100px)', lineHeight: 0.98 }}>Your rules.<br /><span className="glow-text">Odin’s eye.</span></h1>
            <p style={{ margin: 0, fontSize: 21, lineHeight: 1.55, color: '#c6d0ca', maxWidth: 600 }}>Build AI agents that trade any token on Robinhood Chain — Stock Tokens, stablecoins, anything with a pool. You carve the strategy. Your take-profit and stop-loss stand guard. The AI can never touch them.</p>
            <div className="row" style={{ gap: 14 }}>
              <button className="hero" onClick={go} disabled={busy}>{ctaLabel}</button>
              <a href="#console" className="btn-link">▶ Watch an agent think</a>
            </div>
            {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
            <ul className="row" style={{ margin: 0, padding: 0, listStyle: 'none', gap: '10px 22px', fontSize: 14, color: '#a9b6af' }}>
              <li>✦ Starts in paper mode</li>
              <li>✦ Withdrawals only to your wallet</li>
              <li>✦ No unlimited approvals, ever</li>
            </ul>
          </div>
          <div style={{ flex: '1 1 440px', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: 520, maxWidth: '100%', aspectRatio: '1 / 1' }}>
              <svg className="spin-slow" viewBox="0 0 400 400" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                <defs><path id="runePath" d="M200,200 m-160,0 a160,160 0 1,1 320,0 a160,160 0 1,1 -320,0" /></defs>
                <circle cx="200" cy="200" r="190" fill="none" stroke="#46F29B" strokeWidth="1" strokeDasharray="2 10" opacity="0.8" />
                <circle cx="200" cy="200" r="176" fill="none" stroke="#D8CFAE" strokeWidth="1" opacity="0.35" />
                <text fontFamily="JetBrains Mono, monospace" fontSize="11" fill="#46F29B" letterSpacing="6"><textPath href="#runePath">ᚠᚢᚦᚨᚱᚲ · SEE EVERYTHING · ᚷᚹᚺᚾᛁᛃ · DECIDE WITH DISCIPLINE · ᛇᛈᛉᛊᛏᛒ ·</textPath></text>
              </svg>
              <svg className="spin-rev" viewBox="0 0 400 400" aria-hidden="true" style={{ position: 'absolute', inset: '9%', width: '82%', height: '82%' }}>
                <circle cx="200" cy="200" r="196" fill="none" stroke="#46F29B" strokeWidth="2" strokeDasharray="120 40 10 40" opacity="0.55" />
              </svg>
              <div className="float" style={{ position: 'absolute', inset: '19%', borderRadius: '50%', overflow: 'hidden', border: '2px solid #46F29B', boxShadow: '0 0 80px rgba(70,242,155,0.55)' }}>
                <img src="/art/mascot.jpg" alt="Odin in a green feathered hat with a cyber raven on his shoulder" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <FloatCard className="float-2" style={{ left: '-6%', top: '14%' }} tone="var(--rune)" kicker="BUY · FILLED" text="200 USDG → WETH" />
              <FloatCard className="float-3" style={{ right: '-6%', top: '46%' }} tone="var(--gold)" kicker="VALKYRIE · ARMED" text="Stop-loss −5% set" />
              <FloatCard className="float" style={{ left: '4%', bottom: '4%' }} tone="var(--ember)" kicker="SIGNER · REFUSED" text="price_deviation" />
            </div>
          </div>
        </div>
      </section>

      <Ticker />

      {/* ── console ── */}
      <section id="console" style={{ position: 'relative', padding: '110px 24px' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(40% 50% at 50% 40%, rgba(70,242,155,0.12), transparent 70%)' }} />
        <div className="row" style={{ position: 'relative', maxWidth: 1280, margin: '0 auto', gap: 56, alignItems: 'center' }}>
          <Reveal className="col" >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 480 }}>
              <span className="eyebrow">Watch an agent think</span>
              <h2 style={{ margin: 0, fontSize: 'clamp(36px, 5vw, 54px)', lineHeight: 1.05 }}>Every decision,<br />out in the open.</h2>
              <p style={{ margin: 0, fontSize: 18, color: 'var(--soft)' }}>Each tick your agent reads the market, forms a thesis and says exactly what would prove it wrong. Then the risk engine and the signer get the final word — not the AI.</p>
              <div className="row" style={{ gap: 10 }}>
                <span className="tag good">Thesis + invalidation</span>
                <span className="tag good">Risk checks</span>
                <span className="tag good">On-chain quote</span>
              </div>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div style={{ width: 'min(640px, 92vw)' }}>
              <TypeConsole title="einherjar://trend-follower · tick" lines={CONSOLE} />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── pantheon ── */}
      <section id="pantheon" style={{ padding: '30px 24px 110px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 44 }}>
          <Reveal>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <span className="eyebrow">The Pantheon</span>
                <h2 style={{ margin: 0, fontSize: 'clamp(38px, 5.5vw, 62px)', lineHeight: 1.02 }}>Six powers.<br />One seat. Yours.</h2>
              </div>
              <p style={{ margin: 0, maxWidth: 420, color: 'var(--soft)', fontSize: 17 }}>Odin’s old apparatus of sight, rebuilt for markets. Each power is a real part of the platform.</p>
            </div>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: 20 }}>
            {PANTHEON.map((p, i) => (
              <Reveal key={p.kicker} delay={(i % 3) * 90} className={p.wide ? 'pantheon-wide' : ''}>
                <article className="card lift" style={{ padding: 0, overflow: 'hidden', minHeight: p.wide ? 400 : 360, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
                  {p.art ? (
                    <img src={p.art} alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <GuardArt />
                  )}
                  <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: p.wide ? 'linear-gradient(90deg, rgba(5,10,8,0.95) 0%, rgba(5,10,8,0.55) 50%, transparent 80%)' : 'linear-gradient(0deg, rgba(5,10,8,0.97) 20%, transparent 75%)' }} />
                  <div style={{ position: 'relative', padding: p.wide ? 40 : 30, maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <span className="eyebrow" style={{ color: p.art ? 'var(--rune)' : 'var(--gold)' }}>{p.kicker}</span>
                    <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: p.wide ? 36 : 27, lineHeight: 1.12 }}>{p.title}</h3>
                    <p style={{ margin: 0, color: '#c6d0ca', fontSize: 15 }}>{p.text}</p>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── facts ── */}
      <section aria-label="Facts" style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: 'linear-gradient(180deg, #07120d, #050a08)' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '72px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 32 }}>
          {[
            { n: 3, suffix: 's', text: 'between every take-profit and stop-loss check', gold: false },
            { n: 28, suffix: '', text: 'Chainlink price feeds refereeing trades', gold: false },
            { n: 1, suffix: '', text: 'pinned router — the only place a swap can go', gold: true },
            { n: 0, suffix: '', text: 'unlimited approvals. Every one is exact.', gold: true },
          ].map((f, i) => (
            <Reveal key={f.text} delay={i * 90}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 76, lineHeight: 1, color: f.gold ? 'var(--gold)' : 'var(--rune)', textShadow: `0 0 30px ${f.gold ? 'rgba(229,217,168,0.35)' : 'rgba(70,242,155,0.5)'}` }}>
                  <CountUp value={f.n} format={(v) => `${Math.round(v)}${f.suffix}`} />
                </strong>
                <span style={{ color: 'var(--soft)' }}>{f.text}</span>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── safety ── */}
      <section id="safety" style={{ padding: '110px 24px' }}>
        <div className="row" style={{ maxWidth: 1280, margin: '0 auto', gap: 56, alignItems: 'center' }}>
          <Reveal>
            <div style={{ width: 'min(600px, 92vw)', borderRadius: 22, overflow: 'hidden', border: '1px solid rgba(70,242,155,0.35)', boxShadow: '0 30px 100px -30px rgba(70,242,155,0.4)' }}>
              <img src="/art/gungnir.jpg" alt="The spear Gungnir wrapped in green circuitry" style={{ display: 'block', width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }} />
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 520 }}>
              <span className="eyebrow">Safety by design</span>
              <h2 style={{ margin: 0, fontSize: 'clamp(34px, 5vw, 52px)', lineHeight: 1.05 }}>The AI proposes.<br />The spear decides.</h2>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  ['The AI never holds keys.', 'It can only state an intent.'],
                  ['Withdrawals go only to you.', 'No other destination exists.'],
                  ['Every swap is priced twice.', 'An on-chain quote and a Chainlink referee.'],
                  ['Your key, whenever you want it.', 'Export with your own wallet signature.'],
                ].map(([a, b]) => (
                  <li key={a} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                    <span style={{ flex: '0 0 auto', width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--rune)', color: 'var(--rune)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 14px -2px rgba(70,242,155,0.6)' }}>✓</span>
                    <span><strong style={{ color: 'var(--text-hi)' }}>{a}</strong> <span style={{ color: 'var(--soft)' }}>{b}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      <section aria-label="Risk" style={{ padding: '0 24px 80px' }}>
        <Reveal>
          <div className="warnbox row" style={{ maxWidth: 1280, margin: '0 auto', padding: '26px 30px', gap: '10px 30px' }}>
            <strong style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--gold)' }}>Fate is not for sale.</strong>
            <span style={{ flex: '1 1 520px' }}>Markets move, theses fail and capital can be lost. Odin Robinhood gives you sight, discipline and protection you set before the battle — not guaranteed returns.</span>
          </div>
        </Reveal>
      </section>

      {/* ── final CTA ── */}
      <section aria-label="Get started" style={{ position: 'relative', minHeight: 560, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', overflow: 'hidden' }}>
        <img src="/art/seat.jpg" alt="" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55 }} />
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(50% 60% at 50% 50%, rgba(5,10,8,0.3), #050A08 85%)' }} />
        <Embers count={14} />
        <Reveal>
          <div style={{ position: 'relative', padding: '80px 24px', display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
            <h2 style={{ margin: 0, fontWeight: 900, fontSize: 'clamp(46px, 7vw, 86px)', lineHeight: 1, textShadow: '0 0 50px rgba(70,242,155,0.45)' }}>The seat is open.</h2>
            <p style={{ margin: 0, fontSize: 20, color: '#c6d0ca', maxWidth: 620 }}>Connect a wallet, carve your first strategy and watch your agent trade on paper — in minutes.</p>
            <button className="hero" onClick={go} disabled={busy}>{signedIn ? 'Open your agents' : 'Take the seat'}</button>
          </div>
        </Reveal>
      </section>

      <footer style={{ borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ maxWidth: 1280, margin: '0 auto', padding: '34px 24px 46px', gap: 24, fontSize: 14, color: 'var(--muted)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 900, letterSpacing: '0.16em', color: 'var(--text)' }}>ODIN <span style={{ color: 'var(--rune)' }}>ROBINHOOD</span></span>
          <span>See everything. Decide with discipline.</span>
          <span style={{ flex: 1 }} />
          <Link href="/docs" style={{ color: 'var(--muted)' }}>Docs</Link>
          <Link href="/status" style={{ color: 'var(--muted)' }}>Status</Link>
          <span>Robinhood Chain · 4663</span>
        </div>
      </footer>
    </div>
  );
}

function FloatCard({ className, style, tone, kicker, text }: { className: string; style: CSSProperties; tone: string; kicker: string; text: string }) {
  return (
    <div className={className} style={{ position: 'absolute', ...style, padding: '12px 16px', borderRadius: 14, border: `1px solid ${tone}`, background: 'rgba(6,20,14,0.88)', backdropFilter: 'blur(8px)', boxShadow: '0 12px 40px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="mono" style={{ fontSize: 11, color: tone }}>{kicker}</span>
      <strong style={{ fontSize: 15 }}>{text}</strong>
    </div>
  );
}

/** Valkyries tile: a live-looking price line between a glowing take-profit and stop-loss. */
function GuardArt() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', top: 34, left: 30, right: 30, height: 170 }}>
      <div className="glowline" style={{ position: 'absolute', left: 0, right: 0, top: 18, borderTop: '2px dashed var(--rune)' }} />
      <span className="mono" style={{ position: 'absolute', left: 0, top: -2, fontSize: 11, color: 'var(--rune)' }}>TAKE-PROFIT +8%</span>
      <svg viewBox="0 0 300 120" style={{ position: 'absolute', left: 0, right: 0, top: 30, width: '100%', height: 110 }}>
        <polyline className="draw" points="0,70 30,64 60,72 90,55 120,58 150,40 180,48 210,36 240,44 270,30 300,38" fill="none" stroke="#ECE7D6" strokeWidth="2.5" />
      </svg>
      <div className="glowline" style={{ position: 'absolute', left: 0, right: 0, top: 150, borderTop: '2px dashed var(--ember)' }} />
      <span className="mono" style={{ position: 'absolute', left: 0, top: 154, fontSize: 11, color: 'var(--ember)' }}>STOP-LOSS −5%</span>
    </div>
  );
}
