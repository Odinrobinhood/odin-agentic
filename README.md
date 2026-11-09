# Odin Agentic

AI platform for Robinhood Chain. Design: [`docs/architecture.md`](docs/architecture.md), story: [`docs/narrative.md`](docs/narrative.md).

## Layout

| Path | What |
|---|---|
| `apps/api` | API Service (architecture §3.2): SIWE auth, JWT + rotating refresh tokens, owner-scoped agent management; `odin-api` service |
| `packages/shared` | Chain constants, rejection codes, Uniswap path codec, signer request schemas, untrusted-text sanitizer |
| `packages/db` | Postgres + Timescale migrations (`migrations/*.sql`) and runner |
| `packages/signer` | Isolated signer (architecture §3.8): pinned router/recipient/deadline, path validation, separate agent/guard channels and quotas |
| `packages/risk` | Pre-trade Risk Engine (architecture §3.7): asset/route/stock checks, balance + gas reserve, optional user limits, slippage → amountOutMin, referee price sanity, guard exit rules |
| `packages/executor` | Executor (architecture §3.9): allowance → approve → swap via the signer, ordered RPC fallback broadcast, per-wallet nonce manager, receipt + Transfer-log amounts, nonce watchdog |
| `packages/market` | Market Data (architecture §3.6): token registry, routing to USDG/WETH, minute USDG price snapshots; `odin-market` service |
| `packages/decision` | Decision Engine (architecture §3.5): provider interface, Claude provider with structured output, prompt with untrusted data blocks, daily token meter |
| `packages/runtime` | Agent Runtime + Scheduler (architecture §3.3–3.4): tick flow, paper mode, positions + TP/SL arming, leased scheduling; `odin-runtime` service |
| `packages/guard` | Guard Watcher (architecture §3.10): realizable-price TP/SL monitoring, guard-channel exits, retries + alerts; `odin-guard` service (own OS user and DB role) |
| `deploy/` | Provisioning, systemd unit, verified mainnet config, staging E2E checks |

## Develop

Node ≥ 22.18 runs the `.ts` sources directly (type stripping), so there is no build step.

```
pnpm install
pnpm typecheck
pnpm test                                    # unit tests
TEST_DATABASE_URL=postgresql://... pnpm test # + Postgres integration tests
DATABASE_URL=postgresql://... pnpm migrate
```

## Deploy (staging host)

```
git archive --format=tar.gz -o release.tgz HEAD   # committed tree only: other sessions' uncommitted work never ships
# on the host, as root:
bash deploy/provision.sh release.tgz
bash deploy/staging-e2e.sh
```

The staging seed is generated on the host and must never be funded.
