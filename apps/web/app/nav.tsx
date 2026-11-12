'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { call, short } from '@/lib/client';

const APP_LINKS = [
  ['/agents', 'Agents'],
  ['/portfolio', 'Portfolio'],
  ['/analyst', 'Analyst'],
  ['/alerts', 'Signals & alerts'],
  ['/notifications', 'Notifications'],
] as const;

export default function Nav() {
  const path = usePathname();
  const [me, setMe] = useState<{ address: string } | null>(null);
  useEffect(() => {
    call('GET', '/me').then(setMe).catch(() => setMe(null));
  }, []);
  const logout = async (all: boolean) => {
    await fetch(`/api/auth/logout${all ? '?all=1' : ''}`, { method: 'POST', headers: { 'x-odin': '1' } });
    location.href = '/';
  };
  const on = (href: string) => (path === href || path.startsWith(`${href}/`) ? 'on' : '');
  return (
    <header className="nav">
      <Link href="/" className="brand" aria-label="Odin Robinhood home">
        <img src="/art/mascot.jpg" alt="" />
        <span>ODIN <b>ROBINHOOD</b></span>
      </Link>
      {me && (
        <nav className="links" aria-label="App">
          {APP_LINKS.map(([href, label]) => (
            <Link key={href} href={href} className={on(href)}>{label}</Link>
          ))}
        </nav>
      )}
      <span className="spacer" />
      <nav className="links" aria-label="Help">
        <Link href="/docs" className={on('/docs')}>Docs</Link>
        <Link href="/status" className={on('/status')}>Status</Link>
      </nav>
      {me && (
        <span className="row" style={{ gap: 8 }}>
          <span className="tag good"><span className="live-dot" style={{ width: 6, height: 6 }} />{short(me.address)}</span>
          <button className="ghost" onClick={() => logout(false)}>Log out</button>
          <button className="ghost" onClick={() => logout(true)} title="Ends every session of this wallet">Everywhere</button>
        </span>
      )}
    </header>
  );
}
