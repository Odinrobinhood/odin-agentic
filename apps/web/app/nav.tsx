'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { call, short, signIn } from '@/lib/client';

const GROUPS: { title: string; links: [string, string][] }[] = [
  { title: 'Trade', links: [['/agents', 'Agents'], ['/alerts', 'Signals & alerts']] },
  { title: 'Insights', links: [['/analyst', 'Market analyst'], ['/portfolio', 'Portfolio']] },
  { title: 'Your account', links: [['/notifications', 'Notifications']] },
  { title: 'Resources', links: [['/docs', 'How it works'], ['/status', 'System status']] },
];
const TABS: [string, string][] = [['/agents', 'Agents'], ['/analyst', 'Analyst'], ['/portfolio', 'Portfolio'], ['/docs', 'More']];

/** App shell: grouped sidebar, top bar with breadcrumb + network + wallet, bottom tabs on phones. */
export default function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<{ address: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('GET', '/me').then(setMe).catch(() => setMe(null));
  }, [path]);
  const on = (href: string) => (path === href || path.startsWith(`${href}/`) ? 'on' : '');
  const crumb = path === '/' ? 'home' : path.split('/').filter(Boolean)[0];
  const connect = async () => {
    setBusy(true);
    try {
      await signIn();
      location.href = '/agents';
    } catch {
      setBusy(false);
    }
  };
  const logout = async (all: boolean) => {
    await fetch(`/api/auth/logout${all ? '?all=1' : ''}`, { method: 'POST', headers: { 'x-odin': '1' } });
    location.href = '/';
  };
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sidebar">
        <Link href="/" className="brand" aria-label="Odin Robinhood home">
          <img src="/art/mascot.jpg" alt="" />
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
          <Link href="/" className="crumb" aria-label="Home">odin / <b>_{crumb}</b></Link>
          <span style={{ flex: 1 }} />
          <span className="chip"><span className="live-dot" />Robinhood Chain</span>
          {me ? (
            <>
              <span className="chip mono" title={me.address}>{short(me.address)}</span>
              <button className="ghost" onClick={() => logout(false)}>Log out</button>
              <button className="ghost" onClick={() => logout(true)} title="Ends every session of this wallet">Everywhere</button>
            </>
          ) : me === null ? (
            <button onClick={connect} disabled={busy}>{busy ? 'Check your wallet…' : 'Connect wallet'}</button>
          ) : null}
        </header>
        {children}
      </div>
      <nav className="bottom-tabs" aria-label="Tabs">
        {TABS.map(([href, label]) => (
          <Link key={href} href={href} className={on(href)}>{label}</Link>
        ))}
      </nav>
    </div>
  );
}
