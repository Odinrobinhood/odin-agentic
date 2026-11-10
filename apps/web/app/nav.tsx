'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { call, short } from '@/lib/client';

export default function Nav() {
  const [me, setMe] = useState<{ address: string } | null>(null);
  useEffect(() => {
    call('GET', '/me').then(setMe).catch(() => setMe(null));
  }, []);
  const logout = async (all: boolean) => {
    await fetch(`/api/auth/logout${all ? '?all=1' : ''}`, { method: 'POST', headers: { 'x-odin': '1' } });
    location.href = '/';
  };
  return (
    <header className="nav">
      <span className="brand">ODIN AGENTIC</span>
      {me && (
        <>
          <Link href="/agents">Agents</Link>
          <Link href="/portfolio">Portfolio</Link>
          <Link href="/analyst">Analyst</Link>
          <Link href="/alerts">Signals &amp; Alerts</Link>
          <Link href="/notifications">Notifications</Link>
        </>
      )}
      <Link href="/docs">Docs</Link>
      <Link href="/status">Status</Link>
      <span className="spacer" />
      {me ? (
        <span className="row">
          <span className="mono muted">{short(me.address)}</span>
          <button className="ghost" onClick={() => logout(false)}>Log out</button>
          <button className="ghost" onClick={() => logout(true)}>Log out everywhere</button>
        </span>
      ) : null}
    </header>
  );
}
