# Odin Agentic — Architecture

> An AI platform for Robinhood Chain with four utilities:
> 1. **AI Trading Agent** — each user owns one or more AI agents that make decisions and execute trades for the user's own wallet.
> 2. **AI Market Analyst** — a chat analyst that answers questions about any token or stock on Robinhood Chain using live on-chain data.
> 3. **AI Signals & Alerts** — AI-generated and user-defined signals delivered as alerts, without executing trades.
> 4. **Portfolio Tracker** — balances, positions and PnL for any wallet on Robinhood Chain.

---

## 1. System overview

| Aspect | Decision |
|---|---|
| Chain | Robinhood Chain mainnet (Arbitrum Orbit L2, chain ID `4663`, testnet `46630`), gas paid in ETH |
| Base assets | **Only ETH and USDG on Robinhood Chain.** Deposits and each agent's `quote_asset` are USDG or ETH (held as WETH for trading); native ETH is gas only |
| Tradable assets | Any token on Robinhood Chain (Stock Tokens or any other ERC-20) that has a pool, chosen by the user, bought and sold against the base asset. Robinhood Chain only |
| Venue | Uniswap v3 pools on Robinhood Chain via `SwapRouter02` |
| Product model | Personal bot per user; no marketplace, no copy-trading between users |
| Utilities | AI Trading Agent, AI Market Analyst, AI Signals & Alerts, Portfolio Tracker — all on Robinhood Chain only |
| Agent brain | LLM fully designed by the user (prompt, model, parameters, input data, cadence), structured output (JSON schema) |
| TP / SL | Fully controlled by the user: on/off, any value, editable at any time |
| Execution | One agent wallet per agent, signed by an isolated signer |
| Login | Sign-In With Ethereum (SIWE) |

---

## 2. Design principles

1. **The LLM never touches keys or calldata.** It only produces an *intent* (buy/sell/hold + size). Everything that reaches the chain goes through the risk engine and the signer.
2. **The signer only accepts named intents**, never raw transactions. An outbound transfer to an arbitrary address cannot be expressed — neither directly nor indirectly through an approval to an arbitrary spender or a swap through an arbitrary pool.
3. **User's money, user's rules.** How the AI thinks, when it trades, how much, which tokens, and TP/SL are all decided by the user. The platform imposes no strategy limits. It only enforces technical limits: the token must be on Robinhood Chain and have a pool, the balance must be sufficient, the signer only accepts intents, and there is an LLM token budget.
4. **Protection (SL/TP) is independent of LLM decisions.** Guards keep running when an agent is paused or the LLM provider is down, and are never blocked by limits meant to restrain the agent (see §3.7, §3.8).
5. **On-chain strings are untrusted data.** Token names, symbols and any other contract-supplied text never become instructions to an LLM (see §3.5).
6. **Fail loudly.** Every rejection carries a machine-readable code all the way to the UI.

---

## 3. Components

```
                    ┌──────────────────────┐
   User (browser) ─▶│  Web App (Next.js)   │
                    └──────────┬───────────┘
                               │ HTTPS (SIWE JWT)
                    ┌──────────▼───────────┐
                    │      API Service     │──────────┐
                    └──┬───────┬───────┬───┘          │
                       │       │       │              ▼
          ┌────────────▼┐ ┌────▼─────┐ ┌▼──────────┐ ┌──────────────┐
          │  Scheduler  │ │ Agent    │ │ Notifier  │ │  Postgres    │
          │  (ticks)    │ │ Runtime  │ │           │ │ (+Timescale) │
          └──────┬──────┘ └──┬───┬───┘ └───────────┘ └──────────────┘
                 │           │   │
                 │   ┌───────▼┐ ┌▼────────────┐
                 │   │Decision│ │ Risk Engine │
                 │   │Engine  │ └──────┬──────┘
                 │   │ (LLM)  │        │ validated intent
                 │   └───▲────┘ ┌──────▼──────┐
                 │       │      │   Signer    │  (separate process & OS user)
          ┌──────▼───────┴┐     └──────┬──────┘
          │  Market Data  │            │ signed tx
          └──────┬────────┘     ┌──────▼──────┐
                 │              │  Executor   │──▶ RPC pool ──▶ Robinhood Chain
          ┌──────▼────────┐     └──────┬──────┘
          │ Guard Watcher │──intent───▶│ (SL/TP)
          └───────────────┘            ▼
                                 receipt → DB

   Shared by the other utilities (read-only, never reach the Signer):

   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
   │ Analyst      │   │ Signal       │   │ Portfolio        │
   │ Service      │   │ Service      │   │ Service          │
   └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘
          │                  │                    │
          └────────┬─────────┴──────────┬─────────┘
                   ▼                    ▼
            Market Data           Chain Indexer ──▶ Robinhood Chain
                   │                    │
                   └──────▶ Postgres ◀──┘        Signal Service ──▶ Notifier
```

### 3.1 Web App
- Next.js. Pages: onboarding, agent list, AI builder, token picker, TP/SL & risk settings, paper/backtest, agent dashboard (positions, NAV, PnL, decision history + rationale), deposit/withdraw, key export, AI analyst chat, signals & alerts, portfolio tracker, notifications.
- Never holds secrets; everything goes through the API.

### 3.2 API Service
- SIWE auth: short-lived access JWT (15 minutes) + opaque refresh token with rotation.
- CRUD for agents, configs, risk profiles, history, balances.
- Withdraw and key-export endpoints require a fresh SIWE signature (step-up).

### 3.3 Scheduler
- Emits a *tick* per agent according to the agent's cadence (minimum floor: 60 seconds, matching the market snapshot resolution).
- Per-agent lease so one agent is never processed by two workers at once.

### 3.4 Agent Runtime
- On each tick: load market snapshot + portfolio → call Decision Engine → send intent to Risk Engine → forward to Signer/Executor → record the result.
- Stores every decision with prompt hash, response, model + version, and rationale.
- **Paper mode**: identical flow up to the Risk Engine; the fill is then simulated from the pool's realizable price (including fee & slippage) without calling the Signer. Data is tagged `mode = paper`.
- **Backtest**: a specific config version is replayed against historical `market_snapshots` by a separate worker; results go to the `backtests` table.

### 3.5 Decision Engine (LLM)
- **Provider abstraction**: one interface `Decide(context) → Decision`, one implementation per provider (switching models requires no other code change).
- **User-designed AI** — every field below belongs to the user and can be changed at any time (each change is stored as a new version):
  | Setting | Content |
  |---|---|
  | `system_prompt` / `mandate` | Free text: trading style, strategy, personality, rules |
  | `model` | Choice among supported providers |
  | `temperature`, `max_tokens` | Model parameters. Current Claude models reject sampling parameters, so `temperature` is stored but not sent; depth is controlled by effort (`DECISION_EFFORT`, default `high`) |
  | `assets` | Tokens the agent may trade: any ERC-20 contract address on Robinhood Chain (Stock Tokens, memecoins, stablecoins, etc.), added by the user via search or by pasting an address |
  | `quote_asset` | The agent's base asset: **USDG or WETH only** (WETH is shown to users as ETH). Enforced by the API and again by the signer (`quote_not_allowed`) |
  | `context_inputs` | Data injected into the prompt: price, N-period candles, positions, decision history, etc. |
  | `cadence_seconds` | How often the agent thinks (technical floor 60 seconds) |
  | `triggers` (optional) | Price conditions that wake the agent outside its cadence |
- **Model input**: the settings above + price snapshot + positions & balances, assembled according to `context_inputs`.
- **Untrusted on-chain text**: `symbol()`, `name()` and any other contract-supplied string are attacker-controlled. Before entering any prompt they are stripped of control characters and non-printable Unicode, truncated (symbol ≤ 16, name ≤ 64 chars), and placed only inside a delimited data block (e.g. JSON field values) that the system prompt declares as data, never as instructions. Tokens are always referred to by address alongside the label. The same rule applies to the Analyst's tool results and to AI signal profiles.
- **Output (JSON schema, strictly validated)**:
  ```json
  {
    "action": "buy | sell | hold",
    "token": "address (must be in the agent's assets)",
    "size": { "type": "quote_amount | fraction_of_position", "value": "string-decimal" },
    "rationale": "string",
    "thesis": { "claim": "string", "horizon_ticks": 0, "invalidated_if": "string" },
    "confidence": 0.0
  }
  ```
- A token address not in the agent's `assets` → rejected, never guessed.
- **Per-agent daily LLM token meter**; when exhausted → the agent holds until reset, guards keep running.

### 3.6 Market Data
- Execution prices are read from Uniswap v3 pools (`slot0` / quoter) per fee tier.
- Chainlink (where a feed exists) is used as a **referee** to detect a diverging pool, never as the execution price. The token → feed map (`deploy/chainlink.mainnet.json`) is generated from Chainlink reference data and verified on-chain; a Stock Token feed is matched only to Robinhood's beacon proxy with that symbol, and its price already includes the token's `uiMultiplier()`. A 24/7 feed is preferred where one exists; a stale feed skips the check rather than blocking.
- Minute-resolution snapshots are stored in a Timescale hypertable; each decision references the snapshot id it used.
- **Token catalog**: every pool on Robinhood Chain is discovered from the pinned factory's `PoolCreated` events, and every token in them is listed with sanitized labels, a Stock Token flag, whether it is tradable (has a USDG or WETH pool) and a depth hint. Users search it by symbol, name or address and choose any token themselves; there is no curated list. Tokens whose symbol is also used by a deeper token are flagged, since symbols can be copied.
- **Token registry**: when a user adds a token address, the system reads `decimals()` and `symbol()` (display only), then searches the factory across all fee tiers against `quote_asset`, USDG and WETH. Tokens without a pool are rejected with code `no_pool`.
- **Routing**: single-hop when a direct pool exists, otherwise multi-hop via USDG/WETH (`exactInput` with a path). Pools are chosen by deepest liquidity.
- Price snapshots are taken for every token in the registry that has a route (needed by agents, analyst, signals and portfolio valuation).
- Token identity is always the contract address, never the symbol (symbols can be spoofed).

### 3.7 Risk Engine (pre-trade)
Checks in order; all must pass:
1. The token is in the agent's `assets` and has a route on Robinhood Chain. For Stock Tokens: `paused()` and `tokenPaused()` are both false.
2. Size ≤ available balance (after gas reserve).
3. User limits **that the user has enabled** (all optional, empty by default): max position per token, max total exposure, max trades per day, max daily loss.
4. Maximum slippage (user-set) → `amountOutMinimum`.
5. Price sanity: pool price vs referee within tolerance.

Every rejection has a `code` (e.g. `exceeds_position_limit`, `token_paused`, `price_deviation`) that is stored and shown in the UI.

**Guard-originated sells** (SL/TP from the Guard Watcher, and "close all positions" from the user) are protective exits, not agent decisions, so they are treated differently:
- Check 3 is skipped entirely — max trades per day, max daily loss and exposure limits restrain the agent, never an exit.
- Checks 1, 2 and 4 still apply (a paused token or blocked wallet physically cannot transfer; slippage still sets `amountOutMinimum`).
- Check 5 (price sanity): on `price_deviation` the guard does **not** sell into a possibly manipulated pool; it stays `armed`, retries on every new block, and the user is notified immediately. After a user-set timeout (default 5 minutes, configurable, can be set to 0 = sell regardless) it sells anyway, still bounded by max slippage.
- Every guard rejection or retry is notified, never silent.

### 3.8 Signer
- Separate process, separate OS user, listening only on `127.0.0.1` / unix socket.
- Only two intent shapes: `approve(token, amount)` and `swap_exact_in(path, amountIn, amountOutMin)`. The caller cannot set the spender, the recipient or the deadline:
  - **Spender** is always the `SwapRouter02` address pinned in the signer's own config (not received from the API or DB); its `factory()` is verified at signer startup.
  - **Recipient** is always the agent's own wallet.
  - **Deadline** is set by the signer to `now + 60 seconds` (configurable, max 300) and the swap is encoded as `multicall(deadline, [exactInput(...)])`, so a delayed or held-back transaction reverts instead of filling at a stale price. The Executor drops any signed transaction whose deadline has passed and does not rebroadcast it.
- **Path validation** (the signer decodes `path` and checks it independently of the Risk Engine):
  - 1–3 hops; every fee tier is a valid Uniswap v3 tier.
  - The first token is the token being sold and the last is the token being bought; one of them is in the agent's `assets` and the other is the agent's `quote_asset` or another asset of the agent.
  - **Held-token exit:** a token the agent still holds (open live position) but the user has removed from `assets` may only be sold straight into the `quote_asset` — never bought, never swapped into anything else — so its TP/SL and "close all positions" keep working. Stock Token checks still apply.
  - Intermediate tokens may only be USDG or WETH (pinned addresses in signer config).
  - Every hop's pool is resolved by the signer itself from the pinned factory (`getPool(tokenIn, tokenOut, fee)`) and must exist with non-zero liquidity — no pool can be named directly.
  - Every chain read the signer depends on fails closed (`chain_read_failed`).
- `approve` token must be the first token of a swap the agent may perform; amount ≤ the pending swap's `amountIn` (approvals are sized to the trade, so the "unlimited" idiom is rejected by construction).
- Chain ID pinned to `4663`; the signer refuses to sign for any other chain.
- Per-agent daily signature cap, recorded atomically **before** the signature is returned. Guard-originated intents are signed with a flag set by the Guard Watcher's own authenticated channel (not by the API) and draw from a **separate reserved guard quota** (enough to close every open position at least 3 times per day), so an agent that exhausted its cap can always still be exited.
- Keys are derived per agent from a master seed (HKDF-SHA512); the seed never enters the database.

### 3.9 Executor
- Receives signed transactions, broadcasts through several RPCs (ordered fallback), waits for the receipt, and reads `Swap`/`Transfer` events from logs for realized price and amounts.
- Nonces are managed per wallet; a watchdog compares the on-chain nonce with the number of recorded transactions.

### 3.10 Guard Watcher (user-owned TP/SL)
- TP/SL is fully controlled by the user:
  - on/off, each independently;
  - any value, as a percentage from entry or an absolute price, with no width limit;
  - a default level per agent, overridable per position;
  - editable or removable at any time from the dashboard.
- The AI cannot change TP/SL set by the user.
- Removing a token from the agent's assets does not strand an open position: guard and user-close exits of a held token remain allowed (risk check 1 and the signer's held-token exit rule), as a sell into the quote asset only.
- Monitors positions with active stop loss / take profit against the **realizable** price (pool fee included), not the mid price.
- When triggered → creates a `sell` intent through the same Risk Engine & Signer (no bypass path), marked as guard-originated so agent-only limits (§3.7 check 3, the signer's agent signature cap) cannot block it. Signer path, spender and recipient checks still apply in full.
- If a guard sell cannot execute (paused token, price deviation, RPC failure), the guard stays `armed`, retries, and the user is notified on every failed attempt.
- Runs for `active` **and** `paused` agents; only `retired` disables guards.

### 3.11 Notifier
- Notifications for executed trades, triggered guards, low gas balance, agents stopped by repeated errors, and signals/alerts.
- In-app only (user decision 2026-11-10): no Telegram, email or web push. Operator alerts stay in the feed table and the notifier log.

### 3.12 Chain Indexer
- Indexes `Transfer` events of every token in the registry and `Swap` events of every pool on Robinhood Chain, from a configured start block, with reorg handling.
- Tracks the latest indexed block; every read model exposes `as_of_block` so stale data is visible.
- Feeds the Portfolio Service (wallet history), the Analyst (flows, holders, volume) and the Signal Service (volume/liquidity conditions).
- New tokens added to the registry are backfilled from their deployment block.

### 3.13 AI Market Analyst
- Chat interface. The user asks about any token or stock on Robinhood Chain (by address or search).
- The LLM answers through **tools**, never from memory:
  | Tool | Returns |
  |---|---|
  | `get_token` | Metadata, Stock Token flag, routes, pools |
  | `get_price_history` | Candles from `market_snapshots` / indexed swaps |
  | `get_pool_stats` | Liquidity, volume, fee tier per pool |
  | `get_flows` | Net buys/sells, large transfers over a window |
  | `get_holders` | Top holders & concentration from indexed balances |
  | `get_portfolio` | The user's own portfolio (only with the user's session) |
- Every number in an answer carries its source tool and `as_of_block`/timestamp.
- Tool results containing contract-supplied strings follow the untrusted-text rule in §3.5.
- Conversations are stored per user; each answer stores model + version and the tool calls made.
- Shares the provider abstraction and per-user LLM token meter with the Decision Engine.
- Read-only: the analyst has no path to the Risk Engine or Signer.

### 3.14 AI Signals & Alerts
- Two signal types, both delivered through the Notifier, neither executes trades:
  - **Rule alerts (user-defined)**: conditions on price, % change, volume, pool liquidity, large transfers, or wallet activity for any token/wallet on Robinhood Chain.
  - **AI signals**: the user defines a signal profile (prompt, model, watched tokens, cadence, like the agent builder); on each tick the LLM returns a structured signal:
    ```json
    {
      "token": "address",
      "direction": "bullish | bearish | neutral",
      "rationale": "string",
      "thesis": { "claim": "string", "horizon_ticks": 0, "invalidated_if": "string" },
      "confidence": 0.0
    }
    ```
- Rule alerts are evaluated by the Signal Service on every new snapshot / indexed block; AI signals run on the shared Scheduler.
- Cooldown per alert so the same condition does not fire repeatedly.

### 3.15 Portfolio Tracker
- Tracks any wallet on Robinhood Chain: the user's SIWE wallet and agent wallets automatically, plus any watch-only address the user adds.
- Balances from chain reads; history, cost basis and realized PnL from indexed `Transfer`/`Swap` events; unrealized PnL from realizable pool prices.
- Valuation in USDG; tokens without a route are shown with quantity and marked `unpriced`, never valued at zero.
- Aggregate view across all tracked wallets plus per-wallet view.
- Watch-only addresses are read-only; nothing in this service can sign.

---

## 4. Single tick flow

```
Scheduler ──tick(agent)──▶ Agent Runtime
  1. load market snapshot (snapshot_id) + positions + balances
  2. Decision Engine → Decision (validated JSON)            → store decisions
  3. action = hold? → done
  4. Risk Engine(intent)  ── reject → store rejection(code) → done
  5. allowance needed? → Signer.approve → Executor
  6. Signer.swap_exact_in → Executor → receipt
  7. parse logs → store executions, update positions
  8. arm/update SL/TP guards
  9. Notifier
```

---

## 5. Data model (Postgres)

| Table | Main columns |
|---|---|
| `users` | id, wallet_address (SIWE), created_at |
| `agents` | id, user_id, name, status (`draft/active/paused/retired`) |
| `agent_configs` | agent_id, version, system_prompt, model_provider, model_name, temperature, max_tokens, quote_asset, context_inputs, cadence_seconds, triggers, created_at (a new version is a new row, never an update) |
| `risk_profiles` | agent_id, max_position_pct, max_exposure_pct, max_daily_loss_pct, max_trades_per_day, max_slippage_bps — all nullable (NULL = unlimited) |
| `tp_sl_defaults` | agent_id, sl_enabled, sl_mode (`pct/price`), sl_value, tp_enabled, tp_mode, tp_value, deviation_timeout_seconds (default 300, 0 = sell regardless) |
| `agent_wallets` | agent_id, address, derivation_index, custody (`derived/imported`), exported_at |
| `tokens` | address (PK), decimals, symbol, name, is_stock_token, first_seen_at |
| `agent_assets` | agent_id, token_address |
| `routes` | token_address, quote_address, path, pools, updated_at |
| `market_snapshots` | id, ts, token_address, pool, fee_tier, price, oracle_price (hypertable) |
| `decisions` | id, agent_id, snapshot_id, mode (`live/paper`), action, token_address, size, rationale, thesis, model, prompt_hash, response_hash, tokens_used |
| `rejections` | decision_id, code, message |
| `executions` | id, decision_id, kind (`approve/swap`), tx_hash (UNIQUE), status, amount_in, amount_out, gas_used, block |
| `positions` | agent_id, token_address, mode (`live/paper`), qty, avg_entry_price |
| `backtests` | id, agent_id, config_version, from_ts, to_ts, status, result |
| `guards` | position_id, type (`stop_loss/take_profit`), mode (`pct/price`), value, trigger_price, set_by (`default/user_override`), state (`armed/fired/cancelled`), first_triggered_at, attempts, last_rejection_code |
| `portfolio_snapshots` | agent_id, ts, nav_usdg (hypertable) |
| `llm_usage` | user_id, source (`agent/analyst/signal`), source_id, day, tokens |
| `indexer_state` | stream, last_block, last_block_hash, updated_at |
| `transfers` | block, tx_hash, log_index, token_address, from, to, amount (hypertable) |
| `swaps` | block, tx_hash, log_index, pool, sender, recipient, amount0, amount1, price (hypertable) |
| `analyst_conversations` | id, user_id, title, created_at |
| `analyst_messages` | id, conversation_id, role, content, model, tool_calls, as_of_block, tokens_used |
| `rule_alerts` | id, user_id, target (token/wallet), condition, params, channels, cooldown_seconds, enabled |
| `signal_profiles` | id, user_id, version, system_prompt, model_provider, model_name, tokens, cadence_seconds, channels, enabled |
| `signals` | id, profile_id, snapshot_id, token_address, direction, rationale, thesis, confidence, model, created_at |
| `alert_events` | id, source (`rule/signal`), source_id, payload, delivered_channels, created_at |
| `tracked_wallets` | id, user_id, address, kind (`siwe/agent/watch`), label |
| `wallet_positions` | address, token_address, qty, cost_basis, realized_pnl, as_of_block |

---

## 6. Custody & security

- **Default**: agent wallets are created by the platform (custodial), derived from the master seed, and **exportable by the user at any time**.
- Users deposit only Robinhood Chain assets: native ETH for gas, plus trading capital in the agent's base asset — USDG, or WETH for an ETH-based agent (native ETH is not traded; Uniswap v3 pools only hold WETH). Withdrawals go only to the user's SIWE wallet.
- The master seed is stored as a file (`0400`, dir `0700`) on the signer host, encrypted via KMS/secret store before any real user funds arrive. Never in env vars, never in the database.
- The seed is not rotated after wallets are funded (that would strand funds at the old addresses).
- All services bind to `127.0.0.1`; only the reverse proxy (nginx/Caddy + TLS) is public.
- Rate limiting per IP at the proxy and per user at the API.

---

## 7. Robinhood Chain integration

| Item | Notes |
|---|---|
| Verified mainnet addresses (2026-11-09) | SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2` (`factory()` read on-chain), UniswapV3Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (`router.WETH9()`), USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Paxos docs). Source of truth: `deploy/signer.mainnet.env` |
| Testnet | Uniswap v3 is **not** deployed on testnet `46630` (router and factory have no code there). Staging therefore runs the read/sign path against mainnet with an unfunded staging seed; nothing is broadcast. See §11.6 |
| RPC | At least 2–4 endpoints, ordered fallback; preflight both `eth_chainId` **and** `eth_call` (some providers answer the first but reject the second) |
| Router | `SwapRouter02` — address pinned in signer config; verify `factory()` matches the pools' factory at signer startup and refuse to start on mismatch |
| Stock Tokens | Beacon proxy; monitor `implementation()` periodically. Beacon proxies of `0xe10b6f6b275de231345c20d14ab812db62151b00` (verified 2026-11-10); check `paused()` and `tokenPaused()` on every signature. There is no per-wallet blocklist function on the token |
| Other ERC-20 tokens | Amounts are computed from actual post-swap balances (read from `Transfer` logs), not from the quote, so fee-on-transfer/rebasing tokens are recorded correctly |
| Fee tiers | Read per pool; realizable price = pool price ± one-side fee |
| Block time | ~0.1 seconds — confirmations and scan windows are counted in blocks accordingly, not by other chains' conventions |
| Gas | ETH; gas balance is outside NAV and monitored by the watchdog |

---

## 8. Observability

- Structured logs per service, correlated via `agent_id` + `decision_id`.
- `/healthz` per service reports the build commit.
- Watchdog: repeated failed trades per agent, low gas balance, nonce drift, LLM provider error rate, scheduler lag.
- Operator alerts in `alert_events` and the notifier log (no external channels).

---

## 9. Deployment

- Application hosts: API/runtime/market-data/guard/indexer/analyst/signal/portfolio services, horizontally scalable (per-agent leases prevent duplicate work).
- Postgres + Timescale with replicas and failover.
- Signer host separate from application hosts, separate OS user, reachable only over a private network.
- One systemd unit per service; signer with `NoNewPrivileges`, `ProtectSystem=strict`.
- Daily Postgres backups + periodic restore tests.
- Testnet (`46630`) for staging, mainnet (`4663`) for production.

---

## 10. Launch scope (full product)

Everything below must be live with real money and real data on mainnet before launch. No phased release / MVP.

**User features**
- SIWE login, multi-device sessions, log out of all sessions
- Multiple agents per user, each with its own wallet
- Full AI builder: prompt, model, parameters, assets, quote asset, context inputs, cadence, triggers, with version history & rollback
- Pick any token on Robinhood Chain (search + paste address), single/multi-hop routing
- TP/SL per agent and per position, on/off, percentage or absolute price
- Optional risk limits per agent
- Paper mode (agent runs on live prices without on-chain transactions) and backtesting against snapshot history, before enabling real funds
- Deposit / withdraw / key export, with SIWE step-up
- Agent controls: activate, pause, resume, retire, close all positions
- Dashboard: positions, NAV, realized/unrealized PnL, decision history + rationale + thesis, rejections with their codes, transactions with explorer links
- In-app notifications
- AI Market Analyst chat with on-chain tools and sourced numbers
- AI signal profiles and user-defined rule alerts
- Portfolio tracker for SIWE, agent and watch-only wallets with PnL
- $ODIN token integration — **launch blocker**: its role (§11.4) must be decided and specified in this document before the integration can be built; until then it is not part of the buildable scope

**Production readiness**
- Staging on testnet `46630` with configuration identical to mainnet
- Master seed encrypted in KMS/secret store before the first user deposit
- Security audit of the signer and the withdraw/export flows before launch
- End-to-end mainnet tests with small funds for every flow: buy, sell, multi-hop, TP triggered, SL triggered, withdraw, export
- Chain Indexer fully synced and verified against direct chain reads before launch
- Monitoring, alerting, backups + restore tests active from day one
- Load test of scheduler & runtime at the target number of agents
- Public status page & user documentation

---

## 11. Open decisions

1. Custodial (the default in this document) vs non-custodial (smart account + session key).
2. LLM providers & models supported at launch: **decided** — Anthropic Claude first (`claude-opus-5-5` default, `claude-sonnet-5-5`, `claude-haiku-5-5`) behind the provider interface; other providers can be added without touching the runtime.
3. Who pays for LLM tokens (user directly, per-tier quota, or paid in tokens).
4. Role of the $ODIN token: access gating, tier limits, or paying LLM costs.
5. Regional restrictions (Stock Tokens have jurisdictional restrictions).
6. Testnet staging: deploy our own Uniswap v3 stack on `46630` for full broadcast tests, or keep staging on mainnet reads + small-fund mainnet E2E (§10).
7. Backend language: decided — TypeScript monorepo (pnpm), Node ≥ 22.18 running `.ts` directly via type stripping.
