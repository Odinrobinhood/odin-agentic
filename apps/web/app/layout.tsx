import type { ReactNode } from 'react';
import Nav from './nav';
import './globals.css';

export const metadata = { title: 'Odin Agentic', description: 'AI trading agents, analyst, signals and portfolio on Robinhood Chain' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
