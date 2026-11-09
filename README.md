# Odin Agentic

AI platform for Robinhood Chain. Design: [`docs/architecture.md`](docs/architecture.md), story: [`docs/narrative.md`](docs/narrative.md).

## Layout

| Path | What |
|---|---|
| `packages/shared` | Chain constants, rejection codes, Uniswap path codec, signer request schemas, untrusted-text sanitizer |
| `packages/db` | Postgres + Timescale migrations (`migrations/*.sql`) and runner |
| `packages/signer` | Isolated signer (architecture §3.8): pinned router/recipient/deadline, path validation, separate agent/guard channels and quotas |
| `packages/risk` | Pre-trade Risk Engine (architecture §3.7): asset/route/stock checks, balance + gas reserve, optional user limits, slippage → amountOutMin, referee price sanity, guard exit rules |
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
tar --exclude=node_modules -czf release.tgz package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts docs packages deploy
# on the host, as root:
bash deploy/provision.sh release.tgz
bash deploy/staging-e2e.sh
```

The staging seed is generated on the host and must never be funded.
