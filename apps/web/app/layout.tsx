import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import Nav from './nav';
import './globals.css';

export const metadata = { title: 'Odin Agentic', description: 'AI trading agents, analyst, signals and portfolio on Robinhood Chain' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // reading the request makes every page render per request, so Next.js can stamp the CSP nonce on its scripts
  await headers();
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
