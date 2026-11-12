'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';

type Code = { code: string; area: string; text: string };

const SECTIONS = [
  ['start', 'Getting started'],
  ['agents', 'Agents: strategy, tokens, paper and live'],
  ['risk', 'Risk limits, take-profit and stop-loss'],
  ['funds', 'Deposits, withdrawals and your key'],
  ['ai', 'AI usage and what the AI can and cannot do'],
  ['tools', 'Analyst, signals, alerts, portfolio'],
  ['safety', 'Safety model'],
  ['codes', 'Why was something rejected? (codes)'],
] as const;

/** User documentation (public, no sign-in). The code reference is served by the API so it never drifts. */
export default function Docs() {
  const [codes, setCodes] = useState<Code[]>([]);
  useEffect(() => {
    fetch('/api/public/codes').then((r) => (r.ok ? r.json() : [])).then(setCodes).catch(() => {});
  }, []);
  const areas = [...new Set(codes.map((c) => c.area))];
  return (
    <>
      <PageHero art="/art/knot.jpg" icon="/art/valkyrie.webp" kicker="The lore, made practical" title="How Odin Robinhood works" text="Everything you need to carve a strategy, protect it and read why anything was refused." />
      <div className="panel">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {SECTIONS.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}
        </ol>
      </div>

      <div className="warnbox">Trading is risky. Agents can be wrong, markets move, and you can lose what you deposit. Start in paper mode.</div>

      <h2 id="start">Getting started</h2>
      <div className="panel">
        <ol>
          <li><b>Sign in</b> with a wallet on Robinhood Chain. You only sign a message; nothing is sent on-chain.</li>
          <li><b>Create an agent.</b> Every agent gets its own wallet on Robinhood Chain.</li>
          <li><b>Write its strategy</b> in plain language (the mandate), pick its <b>base asset</b> (USDG or ETH) and how often it thinks (cadence).</li>
          <li><b>Pick the tokens</b> it may trade on the Assets tab.</li>
          <li><b>Set your limits and take-profit / stop-loss</b>.</li>
          <li><b>Run it in paper mode</b> (simulated money, real prices). Try a backtest.</li>
          <li>When you are happy, <b>deposit</b> and switch to <b>live</b>.</li>
        </ol>
      </div>

      <h2 id="agents">Agents: strategy, tokens, paper and live</h2>
      <div className="panel">
        <p><b>Any token you choose.</b> Search by symbol, name or contract address, or paste an address. The only technical requirement is a Uniswap pool against USDG or WETH on Robinhood Chain (directly or through one of them).</p>
        <p><b>Identity is the address.</b> Anyone can create a token with any name. The picker warns when another, bigger token uses the same symbol and when a symbol contains unusual characters (look-alike letters). <b>Stock</b> marks Robinhood Stock Tokens, verified on-chain.</p>
        <p><b>Paper vs live.</b> Paper agents trade with simulated balances at real quotes and never sign a transaction. Going live needs a fresh wallet signature.</p>
        <p><b>Triggers.</b> Besides its cadence, an agent can be woken early by price or volume triggers you define.</p>
        <p><b>Versions.</b> Every strategy change is a new version; you can roll back. Each decision records which version made it, with the AI&apos;s rationale.</p>
      </div>

      <h2 id="risk">Risk limits, take-profit and stop-loss</h2>
      <div className="panel">
        <p><b>Your strategy, your limits.</b> Position size, total exposure, daily loss, trades per day and slippage are optional limits you set. The platform only adds technical limits (for example: no trade with more than 50% slippage against the current quote).</p>
        <p><b>Take-profit and stop-loss belong to you.</b> The AI cannot change or cancel them. A separate guard service checks every protected position every few seconds at the price you could actually sell at, and exits on its own quota, even if the agent is paused, out of AI budget, or the AI is down.</p>
        <p><b>Price safety.</b> Before each trade the pool price is compared with Chainlink&apos;s reference price (ETH and Robinhood Stock Tokens). If they differ too much the trade waits; a stop-loss still exits after your deviation timeout.</p>
      </div>

      <h2 id="funds">Deposits, withdrawals and your key</h2>
      <div className="panel">
        <p><b>Deposit</b> to the agent wallet on Robinhood Chain: the base asset (USDG or WETH) plus a little native ETH for network fees.</p>
        <p><b>Withdraw</b> any time, in any agent state. Funds always go to the wallet you signed in with; no other destination exists.</p>
        <p><b>Export the key</b> to take full control of the agent wallet in your own wallet app. You confirm with a wallet signature; the key is shown once. Anyone with that key controls the funds.</p>
        <p><b>Close all</b> sells every open position into the base asset.</p>
      </div>

      <h2 id="ai">AI usage and what the AI can and cannot do</h2>
      <div className="panel">
        <p>The AI reads market data and your mandate and proposes <i>one decision</i>: buy, sell or hold, with reasons. It never sees keys and cannot send transactions. Every proposal passes the risk checks and the isolated signer, which only signs swaps into the agent&apos;s own wallet through the pinned Uniswap router.</p>
        <p>Text from the chain (token names, for example) is treated as data, never as instructions.</p>
        <p>There is a daily AI usage budget. When it is used up the agent holds until 00:00 UTC; take-profit and stop-loss keep working.</p>
      </div>

      <h2 id="tools">Analyst, signals, alerts, portfolio</h2>
      <div className="panel">
        <p><b>Analyst:</b> ask about any token on Robinhood Chain. Answers come from on-chain tools and cite the block they are based on.</p>
        <p><b>Signals and alerts:</b> rule alerts (price, change, volume, liquidity, large transfers, wallet activity) and AI signal profiles. They inform you and never trade.</p>
        <p><b>Notifications</b> appear in the app (Notifications page): trades, take-profit / stop-loss exits, failed exits, low gas, alerts and signals.</p>
        <p><b>Portfolio:</b> your sign-in wallet and any wallets you watch, valued at what you could actually sell for. Unknown cost basis is shown as unknown, never as zero.</p>
      </div>

      <h2 id="safety">Safety model</h2>
      <div className="panel">
        <ul>
          <li>Keys live only in an isolated signer service. It signs named actions (swap, exact approve, withdraw to owner, key export) and nothing else.</li>
          <li>The router, recipients and owner bindings are fixed inside the signer; no request can change them.</li>
          <li>Approvals are always the exact trade amount, never unlimited.</li>
          <li>Withdrawals go only to the owner&apos;s wallet; key export needs the owner&apos;s own signature, checked by the signer.</li>
          <li>Every rejection has a code (below), shown wherever the action failed.</li>
        </ul>
        <p className="muted">Service health: see the <a href="/status">status page</a>.</p>
      </div>

      <h2 id="codes">Why was something rejected? (codes)</h2>
      {areas.map((a) => (
        <div className="panel" key={a}>
          <h2 style={{ marginTop: 0 }}>{a}</h2>
          <table>
            <tbody>
              {codes.filter((c) => c.area === a).map((c) => (
                <tr key={c.code} id={`code-${c.code}`}><td className="mono" style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>{c.code}</td><td>{c.text}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {codes.length === 0 && <p className="muted">Loading the code reference…</p>}
    </>
  );
}
