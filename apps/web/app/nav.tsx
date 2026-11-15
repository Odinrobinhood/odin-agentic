'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call, openConnect, short } from '@/lib/client';
import ConnectDialog from './connect';

const GROUPS: { title: string; links: [string, string][] }[] = [
  { title: 'Trade', links: [['/agents', 'Agents'], ['/alerts', 'Signals & alerts']] },
  { title: 'Insights', links: [['/analyst', 'Market analyst'], ['/portfolio', 'Portfolio']] },
  { title: 'Your account', links: [['/notifications', 'Notifications']] },
  { title: 'Resources', links: [['/docs', 'How it works'], ['/status', 'System status']] },
];
const TABS: [string, string][] = [['/agents', 'Agents'], ['/analyst', 'Analyst'], ['/portfolio', 'Portfolio']];
/** Everything else, reachable on phones through the More sheet. */
const MORE: [string, string][] = [['/alerts', 'Signals & alerts'], ['/notifications', 'Notifications'], ['/docs', 'How it works'], ['/status', 'System status']];

/** App shell: grouped sidebar, top bar with breadcrumb + network + wallet, bottom tabs on phones. */
export default function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<{ address: string } | null | undefined>(undefined);
  const [menu, setMenu] = useState(false); // wallet menu
  const [more, setMore] = useState(false); // phone "More" sheet
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    call('GET', '/me').then(setMe).catch(() => setMe(null));
    setMenu(false);
    setMore(false);
  }, [path]);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('keydown', esc));
  }, [menu]);
  const copy = () => me && navigator.clipboard?.writeText(me.address).catch(() => {});
  const on = (href: string) => (path === href || path.startsWith(`${href}/`) ? 'on' : '');
  const crumb = path === '/' ? 'home' : path.split('/').filter(Boolean)[0];
  // after sign-in: from the landing page go to the agents, elsewhere reload the page that asked
  const signedIn = () => (path === '/' ? (location.href = '/agents') : location.reload());
  const logout = async (all: boolean) => {
    await fetch(`/api/auth/logout${all ? '?all=1' : ''}`, { method: 'POST', headers: { 'x-odin': '1' } });
    location.href = '/';
  };
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <Link href="/" className="brand" aria-label="Odin Robinhood home">
          <img src="/art/medal.webp" alt="" />
          <span>ODIN<br /><b>ROBINHOOD</b></span>
        </Link>
        {GROUPS.map((g) => (
          <nav key={g.title} className="navgroup" aria-label={g.title}>
            <span>{g.title}</span>
            {g.links.map(([href, label]) => (
              <Link key={href} href={href} className={on(href)}>{label}</Link>
            ))}
          </nav>
        ))}
        <div className="foot">
          <span className="row" style={{ gap: 8 }}><span className="live-dot" />Robinhood Chain · 4663</span>
          <span>See everything. Decide with discipline.</span>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <Link href="/" className="m-brand" aria-label="Odin Robinhood home"><img src="/art/medal.webp" alt="" /></Link>
          <Link href="/" className="crumb" aria-label="Home">odin / <b>_{crumb}</b></Link>
          <span style={{ flex: 1 }} />
          <span className="chip mono net-chip" style={{ fontSize: 12 }}><span className="live-dot" /><span className="net-long">Robinhood Chain · </span>4663</span>
          {me ? (
            <div className="wallet on" ref={menuRef}>
              <button className="state" title={me.address} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                <i />{short(me.address)}<span className="caret" aria-hidden="true">▾</span>
              </button>
              {menu && (
                <div className="wallet-menu" role="menu">
                  <span className="mono muted" style={{ fontSize: 11, padding: '6px 12px', wordBreak: 'break-all' }}>{me.address}</span>
                  <button role="menuitem" onClick={() => (copy(), setMenu(false))}>Copy address</button>
                  <button role="menuitem" onClick={() => logout(false)}>Log out</button>
                  <button role="menuitem" onClick={() => logout(true)}>Log out on all devices</button>
                </div>
              )}
            </div>
          ) : me === null ? (
            <div className="wallet">
              <span className="state not"><i /><span className="net-long">Not connected</span></span>
              <button onClick={openConnect}>Connect</button>
            </div>
          ) : null}
        </header>
        {children}
      </div>
      <ConnectDialog onSignedIn={signedIn} />
      {more && (
        <div className="more-sheet" role="dialog" aria-label="More" onClick={(e) => e.target === e.currentTarget && setMore(false)}>
          <nav>
            {MORE.map(([href, label]) => (
              <Link key={href} href={href} className={on(href)} onClick={() => setMore(false)}>{label}</Link>
            ))}
            <span className="row muted" style={{ gap: 8, fontSize: 12.5, padding: '10px 14px 2px' }}><span className="live-dot" />Robinhood Chain · 4663</span>
          </nav>
        </div>
      )}
      <nav className="bottom-tabs" aria-label="Tabs">
        {TABS.map(([href, label]) => (
          <Link key={href} href={href} className={on(href)}>{label}</Link>
        ))}
        <button className={`tab-more ${more || MORE.some(([h]) => on(h)) ? 'on' : ''}`} onClick={() => setMore((m) => !m)} aria-expanded={more}>More</button>
      </nav>
    </div>
  );
}
