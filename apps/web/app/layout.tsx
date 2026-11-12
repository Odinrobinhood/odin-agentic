import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import Nav from './nav';
// fonts bundled from npm (@fontsource): served from this origin, no font CDN, CSP stays 'self'
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/800.css';
import '@fontsource/cinzel/900.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
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
        <Nav />
        {children}
      </body>
    </html>
  );
}
