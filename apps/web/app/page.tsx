'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { call, signIn } from '@/lib/client';
import { Reveal, Ticker, TypeConsole, usePrices, type ConsoleLine } from './motion';

const CONSOLE: ConsoleLine[] = [
  { text: '› read 6 hourly candles · WETH, NVDA', tone: 'muted' },
  { text: '› WETH: two up-closes in a row — entry rule met' },
  { text: 'thesis   upside momentum continues for 3 hours', tone: 'gold' },
  { text: 'wrong if an hourly candle closes > 1.5% below its open', tone: 'gold' },
  { text: 'intent   BUY WETH · 200 USDG', tone: 'rune' },
  { text: '› risk engine · balance ✓ limits ✓ chainlink referee ✓' },
  { text: '› signer · own quote ✓ deepest pool ✓ router pinned ✓' },
  { text: '✓ filled · 200 USDG → WETH at the on-chain quote', tone: 'win' },
  { text: 'valkyries armed · stop-loss −5% · take-profit +8%', tone: 'gold' },
];

const STEPS = [
  ['01', 'Carve the runes', 'Describe the strategy in plain English: base asset, cadence and model.'],
  ['02', 'Choose the realms', 'Any token with a USDG or WETH pool. Copycats and look-alikes are flagged.'],
  ['03', 'Send the Valkyries', 'Take-profit and stop-loss that only you can move — never the AI.'],
  ['04', 'Take the seat', 'Paper first on real prices, backtest, then go live when you are ready.'],
];

const POWERS = [
  { art: '/art/shield.jpg', name: 'Einherjar', what: 'Trading agents', status: 'available', text: 'Own wallet, your schedule or a price trigger, every decision written down with its thesis.' },
  { art: '/art/eye.jpg', name: 'Mímir', what: 'Market analyst', status: 'available', text: 'Answers from on-chain tools only; every number cites its source and block.' },
  { art: '/art/ravens.jpg', name: 'Huginn & Muninn', what: 'Signals & alerts', status: 'available', text: 'AI signals on your schedule and rule alerts the moment a line is crossed.' },
  { art: '/art/seat.jpg', name: 'Hliðskjálf', what: 'Portfolio', status: 'available', text: 'Your wallet, your agents and watched addresses at their realizable value.' },
  { art: '/art/knot.jpg', name: 'The Norns', what: 'Backtests', status: 'beta', text: 'Replay a strategy version over recorded prices before it touches money.' },
  { art: '/art/gungnir.jpg', name: 'Gungnir', what: 'Live trading', status: 'in testing', text: 'The isolated signer is built and reviewed internally; live funds come after a small-funds mainnet trial.' },
];

const ROADMAP = [
  ['01', 'Public launch', 'in pipeline', 'Domain, TLS and the web app open to everyone.'],
  ['02', 'Live trading trial', 'in testing', 'Buy, sell, multi-hop, take-profit, stop-loss and withdraw with small funds on mainnet.'],
  ['03', 'External security audit', 'planned', 'An independent review of the signer, withdrawals and key export.'],
];

const FAQ = [
  ['What is Odin Robinhood?', 'A platform for AI trading agents, a market analyst, signals and a portfolio tracker — on Robinhood Chain only.'],
  ['Can the AI move my funds?', 'No. The AI only states an intent. A separate signer checks it and can swap only through one pinned router into the agent’s own wallet. Withdrawals go only to the wallet you signed in with.'],
  ['Which tokens can an agent trade?', 'Any token you pick that has a pool against USDG or WETH on Robinhood Chain, including Robinhood Stock Tokens. Paused Stock Tokens are refused automatically.'],
  ['Who controls take-profit and stop-loss?', 'You. They are checked every few seconds by a separate guard, keep working while an agent is paused, and the AI cannot change them.'],
  ['What does the AI cost?', 'It depends on the model and how often the agent thinks. The default model costs a fraction of a cent per decision; the builder shows a monthly estimate before you start.'],
  ['What happens if the AI is down?', 'The agent holds and takes no new trades. Take-profit and stop-loss keep running on their own service.'],
];

const statusTone = (s: string) => (s === 'available' ? 'good' : s === 'beta' || s === 'in testing' ? 'warn' : '');

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const prices = usePrices();
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
  const cta = busy ? 'Check your wallet…' : signedIn ? 'Open your agents' : 'Summon an agent';
  const lead = prices[0];

  return (
    <div>
      {/* ── 00 hero ── */}
      <section style={{ maxWidth: 1240, margin: '0 auto', padding: '72px 28px 64px' }}>
        <div className="row" style={{ gap: 48, alignItems: 'stretch' }}>
          <div className="stagger" style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 26, justifyContent: 'center' }}>
            <span className="kicker"><b>00</b> / Odin Robinhood · AI agents on Robinhood Chain</span>
            <h1 className="display" style={{ margin: 0, fontSize: 'clamp(52px, 7.6vw, 108px)' }}>
              Trade with<br />rules,<br /><span style={{ color: 'var(--rune)' }}>not hope.</span>
            </h1>
            <p style={{ margin: 0, fontSize: 19, color: 'var(--soft)', maxWidth: 520 }}>
              You carve the strategy. Your agent trades any token on Robinhood Chain. Your take-profit and stop-loss stand guard — and the AI can never touch them.
            </p>
            <div className="row" style={{ gap: 12 }}>
              <button className="hero" onClick={go} disabled={busy}>{cta}</button>
              <a href="#how" className="btn-link">See how it works</a>
            </div>
            {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
            <div className="row" style={{ gap: 8 }}>
              {['Robinhood Chain', 'USDG', 'WETH', 'Stock Tokens', 'Paper first'].map((c) => <span key={c} className="chip">{c}</span>)}
            </div>
          </div>
          <Reveal delay={120}>
            <div style={{ width: 'min(460px, 88vw)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="card lift" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'hidden' }}>
                  <img className="art" src="/art/mascot.jpg" alt="Odin in a feathered hat with a cyber raven" style={{ display: 'block', width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' }} />
                </div>
                <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
                  <span className="kicker">emblem / odin</span>
                  <span className="row mono" style={{ gap: 8, fontSize: 12, color: 'var(--rune)' }}><span className="live-dot" />agents online</span>
                </div>
              </div>
              <div className="card" style={{ padding: '14px 16px' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="kicker">readout / {lead ? lead.symbol.toLowerCase() : 'market'}</span>
                  <span className="mono muted" style={{ fontSize: 12 }}>USDG · pool mid</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
                  <strong className="num" style={{ fontSize: 30, color: 'var(--ink)', fontWeight: 400 }}>{lead ? lead.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</strong>
                  {lead && lead.changePct !== null && <span className="num" style={{ color: lead.changePct >= 0 ? 'var(--rune)' : 'var(--ember)' }}>{lead.changePct >= 0 ? '+' : '−'}{Math.abs(lead.changePct).toFixed(2)}% · 24h</span>}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <Ticker />

      {/* ── 01 steps ── */}
      <section id="how" style={{ maxWidth: 1240, margin: '0 auto', padding: '96px 28px 40px' }}>
        <Reveal>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
            <h2 className="display" style={{ margin: 0, fontSize: 'clamp(34px, 4.6vw, 60px)' }}>From your rules<br />to a running agent.</h2>
            <span className="kicker"><b>01</b> / 04 · scroll to bring it together</span>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <div className="steps">
            {STEPS.map(([n, t, d]) => (
              <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span className="n"><b>{n}</b> / 04</span>
                <strong style={{ fontSize: 19, color: 'var(--ink)', fontWeight: 600 }}>{t}</strong>
                <span style={{ color: 'var(--muted)', fontSize: 14.5 }}>{d}</span>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── 02 concept ── */}
      <section style={{ maxWidth: 1240, margin: '0 auto', padding: '80px 28px' }}>
        <div className="row" style={{ gap: 56, alignItems: 'flex-start' }}>
          <Reveal>
            <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <span className="kicker"><b>02</b> / the idea</span>
              <h2 className="display" style={{ margin: 0, fontSize: 'clamp(34px, 4.6vw, 60px)' }}>The AI proposes.<br />The spear decides.</h2>
              <p style={{ margin: 0, color: 'var(--soft)', fontSize: 17 }}>Every tick the agent reads the market, forms a thesis and says what would prove it wrong. That is all it can do: state an intent.</p>
              <p style={{ margin: 0, color: 'var(--soft)', fontSize: 17 }}>A risk engine checks balances, your limits and a Chainlink reference price. An isolated signer prices the swap itself and signs only toward one pinned router and the agent’s own wallet.</p>
              <Link href="/docs" className="textlink" style={{ alignSelf: 'flex-start' }}>Read the safety model →</Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div style={{ width: 'min(600px, 90vw)' }}>
              <TypeConsole title="einherjar://trend-follower · live feed" lines={CONSOLE} />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 03 settlement path ── */}
      <section style={{ maxWidth: 1240, margin: '0 auto', padding: '40px 28px 96px' }}>
        <Reveal>
          <span className="kicker"><b>03</b> / how a trade settles</span>
          <div style={{ marginTop: 22, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {[
              ['intent', 'The model', 'buy · sell · hold, with a thesis'],
              ['checks', 'Risk engine', 'balance, your limits, price referee'],
              ['signature', 'Signer', 'own quote, deepest pool, pinned router'],
              ['settlement', 'Robinhood Chain', 'swap lands in the agent wallet'],
            ].map(([k, t, d], i, all) => (
              <div key={k} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="kicker">{String(i + 1).padStart(2, '0')} · {k}</span>
                <strong style={{ fontSize: 18, color: 'var(--ink)', fontWeight: 600 }}>{t}</strong>
                <span className="muted" style={{ fontSize: 14 }}>{d}</span>
                {i < all.length - 1 && <span aria-hidden="true" className="mono" style={{ position: 'absolute', right: -11, top: '50%', transform: 'translateY(-50%)', color: 'var(--rune)', zIndex: 1 }}>→</span>}
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── 04 foundation ── */}
      <section style={{ borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '96px 28px' }}>
          <Reveal>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 30 }}>
              <h2 className="display" style={{ margin: 0, fontSize: 'clamp(34px, 4.6vw, 60px)' }}>Six powers.<br />One seat.</h2>
              <span className="kicker"><b>04</b> / the pantheon</span>
            </div>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 14 }}>
            {POWERS.map((p, i) => (
              <Reveal key={p.name} delay={(i % 3) * 80}>
                <article className="card lift" style={{ padding: 0, overflow: 'hidden', height: '100%' }}>
                  <div style={{ overflow: 'hidden', borderBottom: '1px solid var(--line)' }}>
                    <img className="art" src={p.art} alt="" aria-hidden="true" style={{ display: 'block', width: '100%', aspectRatio: '16 / 8', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="kicker">{p.name}</span>
                      <span className={`pill ${statusTone(p.status)}`}>{p.status}</span>
                    </div>
                    <strong style={{ fontSize: 21, color: 'var(--ink)', fontWeight: 600, letterSpacing: '-0.02em' }}>{p.what}</strong>
                    <span className="muted" style={{ fontSize: 14.5 }}>{p.text}</span>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 05 roadmap ── */}
      <section style={{ borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '96px 28px' }}>
          <Reveal>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 30 }}>
              <h2 className="display" style={{ margin: 0, fontSize: 'clamp(34px, 4.6vw, 60px)' }}>What comes next.</h2>
              <span className="kicker"><b>05</b> / roadmap</span>
            </div>
          </Reveal>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 14 }}>
            {ROADMAP.map(([n, t, s, d], i) => (
              <Reveal key={n} delay={i * 80}>
                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="num" style={{ fontSize: 34, color: 'var(--line-strong)' }}>{n}</span>
                    <span className={`pill ${statusTone(s)}`}>{s}</span>
                  </div>
                  <strong style={{ fontSize: 20, color: 'var(--ink)', fontWeight: 600 }}>{t}</strong>
                  <span className="muted" style={{ fontSize: 14.5 }}>{d}</span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── built with ── */}
      <section aria-label="Built with" className="marquee" style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ padding: '22px 0' }}>
          {[...Array(2)].flatMap((_, k) =>
            ['Robinhood Chain', 'Uniswap v3', 'Chainlink', 'USDG', 'OpenRouter', 'DeepSeek', 'QuoterV2', 'Multicall3'].map((n) => (
              <span key={`${k}-${n}`} style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: '#6f6f6f', whiteSpace: 'nowrap' }}>{n}</span>
            )),
          )}
        </div>
      </section>

      {/* ── 06 faq ── */}
      <section style={{ maxWidth: 1000, margin: '0 auto', padding: '96px 28px' }}>
        <Reveal>
          <span className="kicker"><b>06</b> / questions</span>
          <h2 className="display" style={{ margin: '14px 0 26px', fontSize: 'clamp(34px, 4.6vw, 56px)' }}>Asked at the well.</h2>
          <div style={{ borderTop: '1px solid var(--line)' }}>
            {FAQ.map(([q, a], i) => (
              <details key={q} className="faq">
                <summary><span className="num muted" style={{ fontSize: 13 }}>{String(i + 1).padStart(2, '0')}</span>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── closing band ── */}
      <section style={{ borderTop: '1px solid var(--line)', background: 'var(--surface)' }}>
        <Reveal>
          <div style={{ maxWidth: 1240, margin: '0 auto', padding: '96px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
            <span className="kicker">the seat is open</span>
            <h2 className="display" style={{ margin: 0, fontSize: 'clamp(42px, 6.4vw, 92px)' }}>See everything.<br /><span style={{ color: 'var(--rune)' }}>Decide with discipline.</span></h2>
            <div className="row" style={{ gap: 12, justifyContent: 'center' }}>
              <button className="hero" onClick={go} disabled={busy}>{cta}</button>
              <Link href="/docs" className="btn-link">Read the docs</Link>
            </div>
          </div>
        </Reveal>
      </section>

      <footer style={{ borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '48px 28px 40px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 28 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="lore" style={{ fontWeight: 900, letterSpacing: '0.14em', color: 'var(--ink)' }}>ODIN <span style={{ color: 'var(--rune)' }}>ROBINHOOD</span></span>
            <span className="muted" style={{ fontSize: 14 }}>AI agents on Robinhood Chain.</span>
          </div>
          {[
            ['Product', [['/agents', 'Agents'], ['/analyst', 'Market analyst'], ['/alerts', 'Signals & alerts'], ['/portfolio', 'Portfolio']]],
            ['Resources', [['/docs', 'How it works'], ['/docs#codes', 'Rejection codes'], ['/status', 'System status']]],
          ].map(([title, links]) => (
            <div key={title as string} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="kicker">{title as string}</span>
              {(links as string[][]).map(([href, label]) => <Link key={href} href={href!} className="muted" style={{ fontSize: 14 }}>{label}</Link>)}
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="kicker">Network</span>
            <span className="muted mono" style={{ fontSize: 13 }}>Robinhood Chain · 4663</span>
          </div>
        </div>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '18px 28px 40px', borderTop: '1px solid var(--line)', fontSize: 12.5, color: '#7d7d7d' }}>
          Trading is risky. Agents can be wrong, markets move and you can lose what you deposit. Nothing here is financial advice.
        </div>
      </footer>
    </div>
  );
}
