'use client';
import { PageHero } from '../motion';
import { useEffect, useState } from 'react';

type Code = { code: string; area: string; text: string };

const SECTIONS = [
  ['start', 'Getting started'],
  ['wallet', 'Connecting a wallet'],
  ['agents', 'Agents: strategy, tokens, paper and live'],
  ['strategy', 'Writing a good strategy'],
  ['lifecycle', 'Agent lifecycle'],
  ['risk', 'Risk limits, take-profit and stop-loss'],
  ['funds', 'Deposits, withdrawals and your key'],
  ['costs', 'Fees and costs'],
  ['ai', 'AI usage and what the AI can and cannot do'],
  ['tools', 'Analyst, signals, alerts, portfolio, backtests'],
  ['safety', 'Safety model'],
  ['trouble', 'Troubleshooting'],
  ['glossary', 'Glossary: the names in the lore'],
  ['roadmap', 'Roadmap'],
  ['codes', 'Why was something rejected? (codes)'],
] as const;

type Phase = 'done' | 'now' | 'next';
const ROADMAP: { phase: Phase; title: string; text: string }[] = [
  { phase: 'done', title: 'AI trading agents', text: 'Plain-language strategies, any token with a USDG or WETH pool, paper mode on real prices, versioned strategies, price and volume triggers.' },
  { phase: 'done', title: 'Take-profit and stop-loss guard', text: 'A separate service prices every protected position every 3 seconds at its realizable exit and sells on its own channel.' },
  { phase: 'done', title: 'Market analyst, signals and alerts', text: 'Analyst answers from on-chain tools with cited blocks; AI signal profiles and rule alerts, delivered in the app.' },
  { phase: 'done', title: 'Portfolio and backtests', text: 'Realizable valuation of your wallets and agents; strategy replays over recorded prices.' },
  { phase: 'done', title: 'Public launch', text: 'odinrobinhood.com over HTTPS, wallet sign-in with MetaMask, Rabby and other browser wallets.' },
  { phase: 'done', title: 'Live trading on mainnet', text: 'Agents trade real funds on Robinhood Chain. First live buy and sell confirmed on-chain, about a cent of gas per trade.' },
  { phase: 'done', title: 'Internal security review', text: 'Signer, withdrawals and key export reviewed by three independent reviewers; findings fixed.' },
  { phase: 'now', title: 'Live verification of every money path', text: 'Withdrawals, key export, take-profit / stop-loss exits and two-hop routes with small funds on mainnet.' },
  { phase: 'now', title: 'Sharper agent context', text: 'Agents now see when each position was opened and how long it has been held, so holding-time rules are exact.' },
  { phase: 'next', title: 'Signer keys in a managed key store', text: 'Move the signer’s master key from an encrypted file on the server into a hardware-backed key management service.' },
  { phase: 'next', title: 'Off-site backups and database failover', text: 'Encrypted backups stored off the server and a standby database.' },
  { phase: 'next', title: 'More price referees', text: 'Chainlink reference checks for more Stock Tokens (CLSK, CRWV, EWY, IONQ, NBIS, ORCL, RGTI, RKLB) as their on-chain markets deepen.' },
  { phase: 'next', title: 'AI plans', text: 'Clear limits per plan for how often agents think and which models they use.' },
];
const PHASE_LABEL: Record<Phase, string> = { done: 'done', now: 'in progress', next: 'next' };
const PHASE_TONE: Record<Phase, string> = { done: 'good', now: 'warn', next: '' };

/** User documentation (public, no sign-in). The code reference is served by the API so it never drifts. */
export default function Docs() {
  const [codes, setCodes] = useState<Code[]>([]);
  useEffect(() => {
    fetch('/api/public/codes').then((r) => (r.ok ? r.json() : [])).then(setCodes).catch(() => {});
  }, []);
  const areas = [...new Set(codes.map((c) => c.area))];
  return (
    <>
      <PageHero art="/art/knot.jpg" icon="/art/valkyrie.webp" kicker="The lore, made practical" title="How Odin Robinhood works" text="Everything you need to carve a strategy, protect it, fund it and read why anything was refused." />
      <div className="panel">
        <ol className="docs-toc">
          {SECTIONS.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}
        </ol>
      </div>

      <div className="warnbox">Trading is risky. Agents can be wrong, markets move, and you can lose what you deposit. Start in paper mode. Nothing here is financial advice.</div>

      <h2 id="start">Getting started</h2>
      <div className="panel">
        <ol>
          <li><b>Connect</b> a browser wallet and sign the sign-in message. It is free; nothing is sent on-chain.</li>
          <li><b>Create an agent.</b> Every agent gets its own wallet on Robinhood Chain.</li>
          <li><b>Write its strategy</b> in plain language (the mandate), pick its <b>base asset</b> (USDG or WETH), its model and how often it thinks (cadence).</li>
          <li><b>Pick the tokens</b> it may trade on the Assets tab.</li>
          <li><b>Set take-profit / stop-loss</b> and any limits you want on the Risk tab.</li>
          <li><b>Run it in paper mode</b> (simulated money, real prices) and try a backtest.</li>
          <li>When you are happy, <b>deposit</b> to the agent wallet and switch to <b>live</b>.</li>
        </ol>
      </div>

      <h2 id="wallet">Connecting a wallet</h2>
      <div className="panel">
        <p><b>Supported:</b> browser wallets such as MetaMask and Rabby (desktop). On a phone, open the site inside your wallet app&apos;s browser — the connect dialog offers an <i>Open in MetaMask</i> button.</p>
        <p><b>Several wallets installed?</b> The dialog lists every wallet it finds; pick the one holding the account you want. Your choice is remembered for the next sign-in and for confirmations (going live, withdrawals, key export).</p>
        <p><b>Nothing pops up?</b> Your wallet may already have a request open from an earlier attempt. Click the wallet icon in the browser toolbar (it may be under the puzzle-piece menu), approve or close the request — sign-in continues on its own.</p>
        <p><b>Use a regular account</b> (an externally owned account). Key export needs a signature that the signer can check locally, which smart-contract wallets cannot give.</p>
        <table>
          <tbody>
            <tr><td className="muted">Network</td><td>Robinhood Chain (mainnet)</td></tr>
            <tr><td className="muted">Chain ID</td><td className="mono">4663</td></tr>
            <tr><td className="muted">RPC</td><td className="mono">https://rpc.mainnet.chain.robinhood.com</td></tr>
            <tr><td className="muted">Explorer</td><td className="mono"><a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">robinhoodchain.blockscout.com</a></td></tr>
            <tr><td className="muted">Gas token</td><td>ETH</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>The Deposit panel of every agent has an <i>Add Robinhood Chain to my wallet</i> button. Never paste a private key or seed phrase into any website, including this one.</p>
      </div>

      <h2 id="agents">Agents: strategy, tokens, paper and live</h2>
      <div className="panel">
        <p><b>Any token you choose.</b> Search by symbol, name or contract address, or paste an address. The only technical requirement is a Uniswap pool against USDG or WETH on Robinhood Chain (directly or through one of them).</p>
        <p><b>Identity is the address.</b> Anyone can create a token with any name. The picker warns when another, bigger token uses the same symbol and when a symbol contains unusual characters (look-alike letters). <b>Stock</b> marks Robinhood Stock Tokens, verified on-chain; a paused Stock Token is refused automatically.</p>
        <p><b>Paper vs live.</b> Paper agents trade with simulated balances at real quotes and never sign a transaction. Going live needs a fresh wallet signature (less than 10 minutes old).</p>
        <p><b>Triggers.</b> Besides its cadence, an agent can be woken early by price-above, price-below, percent-change or volume triggers you define.</p>
        <p><b>Versions.</b> Every strategy change is a new version; you can roll back. Each decision records which version made it, with the AI&apos;s rationale and thesis.</p>
      </div>

      <h2 id="strategy">Writing a good strategy</h2>
      <div className="panel">
        <p>The mandate is the only thing the AI follows. Write it like rules for a careful assistant:</p>
        <ul>
          <li><b>Say when to buy, how much, and when to sell.</b> Use amounts in the base asset (&ldquo;spend 25 USDG&rdquo;) and clear conditions.</li>
          <li><b>Name the data it should use</b>: hourly candles, the last price, how long a position has been held. Every position comes with <span className="mono">held_minutes</span>, so rules like &ldquo;sell after 2 hours&rdquo; are exact.</li>
          <li><b>Say what to do otherwise</b> — usually &ldquo;hold&rdquo;. An agent that is unsure holds.</li>
          <li><b>Leave protection to the guard.</b> Put take-profit / stop-loss on the Risk tab; the AI cannot change them.</li>
        </ul>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 14, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
{`Trend follower on WETH and NVDA. Buy one of them with 50 USDG when its last two
hourly candles both closed higher and you hold none of it. Sell the whole position
when the last hourly candle closed more than 1.5% lower, or after it has been held
for 24 hours. Never hold more than one position per token. Otherwise hold.`}
        </pre>
      </div>

      <h2 id="lifecycle">Agent lifecycle</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr><td><span className="tag warn">draft</span></td><td>Being set up. Does not think or trade.</td></tr>
            <tr><td><span className="tag good">active</span></td><td>Thinks on its cadence (minimum 60 seconds) and when a trigger fires.</td></tr>
            <tr><td><span className="tag warn">paused</span></td><td>Stops thinking. Take-profit and stop-loss keep guarding open positions. Agents are paused automatically after 5 failed ticks in a row.</td></tr>
            <tr><td><span className="tag bad">retired</span></td><td>Permanently stopped. Withdrawals and key export still work.</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="risk">Risk limits, take-profit and stop-loss</h2>
      <div className="panel">
        <p><b>Your strategy, your limits.</b> Position size, total exposure, daily loss, trades per day and slippage are optional limits you set. The platform only adds technical limits (for example: no trade with more than 50% slippage against the current quote).</p>
        <p><b>Take-profit and stop-loss belong to you.</b> The AI cannot change or cancel them. A separate guard service checks every protected position every 3 seconds at the price you could actually sell at, and exits on its own quota, even if the agent is paused, out of AI budget, or the AI is down. Defaults apply to every new position; you can override them per position.</p>
        <p><b>Price safety.</b> Before each trade the pool price is compared with Chainlink&apos;s reference price (ETH and Robinhood Stock Tokens). If they differ too much the trade waits; a stop-loss still exits after your deviation timeout.</p>
      </div>

      <h2 id="funds">Deposits, withdrawals and your key</h2>
      <div className="panel">
        <p><b>Deposit</b> to the agent wallet on Robinhood Chain: the base asset (USDG or WETH) plus a little native ETH for network fees (0.002–0.005 ETH covers many trades).</p>
        <p><b>Withdraw</b> any time, in any agent state. Funds always go to the wallet you signed in with; no other destination exists.</p>
        <p><b>Export the key</b> to take full control of the agent wallet in your own wallet app. You confirm with a wallet signature; the key is shown once. Anyone with that key controls the funds.</p>
        <p><b>Close all</b> sells every open position into the base asset.</p>
      </div>

      <h2 id="costs">Fees and costs</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr><td className="muted" style={{ whiteSpace: 'nowrap' }}>Network gas</td><td>Paid in ETH from the agent wallet. Measured on mainnet: about 0.0000042 ETH for an approve plus a swap — around a cent.</td></tr>
            <tr><td className="muted" style={{ whiteSpace: 'nowrap' }}>Pool fee</td><td>Each Uniswap pool charges its own fee (0.01%, 0.05%, 0.3% or 1% of the amount swapped); it is part of the quoted price.</td></tr>
            <tr><td className="muted" style={{ whiteSpace: 'nowrap' }}>Price impact</td><td>Large trades in thin pools move the price; your slippage limit and the signer&apos;s own quote cap it.</td></tr>
            <tr><td className="muted" style={{ whiteSpace: 'nowrap' }}>AI usage</td><td>Every decision uses AI tokens, counted against a daily budget. The model and cadence decide how much; a faster cadence costs more.</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="ai">AI usage and what the AI can and cannot do</h2>
      <div className="panel">
        <p>The AI reads market data and your mandate and proposes <i>one decision</i>: buy, sell or hold, with reasons. It never sees keys and cannot send transactions. Every proposal passes the risk checks and the isolated signer, which only signs swaps into the agent&apos;s own wallet through the pinned Uniswap router.</p>
        <p><b>Models.</b> Choose the model per agent and per signal profile; the list in the builder shows what this server offers, with DeepSeek V4 Flash as the default.</p>
        <p>Text from the chain (token names, for example) is treated as data, never as instructions.</p>
        <p>There is a daily AI usage budget. When it is used up the agent holds until 00:00 UTC; take-profit and stop-loss keep working.</p>
      </div>

      <h2 id="tools">Analyst, signals, alerts, portfolio, backtests</h2>
      <div className="panel">
        <p><b>Analyst:</b> ask about any token on Robinhood Chain. Answers come from on-chain tools and cite the block they are based on.</p>
        <p><b>Signals and alerts:</b> rule alerts (price, change, volume, liquidity, large transfers, wallet activity) and AI signal profiles on your schedule. They inform you and never trade.</p>
        <p><b>Notifications</b> appear in the app (Notifications page): trades, take-profit / stop-loss exits, failed exits, low gas, alerts and signals.</p>
        <p><b>Portfolio:</b> your sign-in wallet and any wallets you watch, valued at what you could actually sell for. Unknown cost basis is shown as unknown, never as zero.</p>
        <p><b>Backtests:</b> replay a strategy version over recorded prices at its cadence (up to 300 decisions). The model only sees data up to each moment; fills use the recorded price plus the pool fee, without price impact. Treat results as a sanity check, not a forecast.</p>
      </div>

      <h2 id="safety">Safety model</h2>
      <div className="panel">
        <ul>
          <li>Keys live only in an isolated signer service. It signs named actions (swap, exact approve, withdraw to owner, key export) and nothing else.</li>
          <li>The router, recipients and owner bindings are fixed inside the signer; no request can change them.</li>
          <li>The signer prices every swap itself and only uses deep pools; approvals are always the exact trade amount, never unlimited.</li>
          <li>Withdrawals go only to the owner&apos;s wallet; key export needs the owner&apos;s own signature, checked by the signer.</li>
          <li>Every rejection has a code (below), shown wherever the action failed.</li>
        </ul>
        <p className="muted">Service health: see the <a href="/status">status page</a>.</p>
      </div>

      <h2 id="trouble">Troubleshooting</h2>
      <div className="panel">
        <p><b>&ldquo;insufficient_balance&rdquo;</b> — the agent wallet does not hold enough of the base asset yet. Deposits can take a few seconds to appear.</p>
        <p><b>Low gas alert</b> — send a little ETH to the agent wallet; without gas no trade or exit can be sent.</p>
        <p><b>A trade &ldquo;waits&rdquo; on price deviation</b> — the pool price is far from Chainlink&apos;s reference. Normal trades wait; stop-loss exits go after your deviation timeout.</p>
        <p><b>The agent holds all the time</b> — read its rationale on the Activity tab. Usually the mandate&apos;s conditions are not met, or it lacks data (add candles in the strategy settings).</p>
        <p><b>Cannot sign in</b> — see <a href="#wallet">Connecting a wallet</a>.</p>
      </div>

      <h2 id="glossary">Glossary: the names in the lore</h2>
      <div className="panel">
        <table>
          <tbody>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>Einherjar</td><td>Your trading agents.</td></tr>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>Valkyries</td><td>The take-profit / stop-loss guard.</td></tr>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>Huginn &amp; Muninn</td><td>The analyst and signals — thought and memory.</td></tr>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>Hliðskjálf</td><td>The portfolio — the seat that sees every realm.</td></tr>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>Gungnir</td><td>Live trading through the isolated signer — the spear that never misses its mark.</td></tr>
            <tr><td className="lore" style={{ whiteSpace: 'nowrap' }}>The hoard</td><td>Your funds: deposits, withdrawals and key export.</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="roadmap">Roadmap</h2>
      <div className="roadmap">
        {(['done', 'now', 'next'] as Phase[]).map((ph) => (
          <div key={ph} className="panel" style={{ marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="kicker">{ph === 'done' ? 'shipped' : ph === 'now' ? 'now' : 'next'}</span>
              <span className={`pill ${PHASE_TONE[ph]}`}>{PHASE_LABEL[ph]}</span>
            </div>
            {ROADMAP.filter((r) => r.phase === ph).map((r) => (
              <div key={r.title} className="roadmap-item">
                <strong>{r.title}</strong>
                <span className="muted">{r.text}</span>
              </div>
            ))}
          </div>
        ))}
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
