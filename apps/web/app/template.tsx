'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/** Re-mounts on every navigation, so each page rises in. The landing page is full-bleed. */
export default function Template({ children }: { children: ReactNode }) {
  const wide = usePathname() === '/';
  return <main className={`page-enter ${wide ? 'wide' : ''}`}>{children}</main>;
}
