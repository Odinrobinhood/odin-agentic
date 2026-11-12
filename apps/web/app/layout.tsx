import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import AppShell from './nav';
// fonts bundled from npm (@fontsource): served from this origin, no font CDN, CSP stays 'self'
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/cinzel/900.css';
import '@fontsource/jetbrains-mono/400.css';
import './globals.css';

export const metadata = {
  title: 'Odin Robinhood',
  description: 'AI trading agents, market analyst, signals and portfolio on Robinhood Chain. Your rules. Odin’s eye.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // reading the request makes every page render per request, so Next.js can stamp the CSP nonce on its scripts
  await headers();
  return (
    <html lang="en">
      <body>
        <div className="atmosphere" aria-hidden="true" />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
