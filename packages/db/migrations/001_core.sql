-- Odin Agentic core schema (architecture §5)
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- addresses are stored lowercase: '0x' + 40 hex chars
CREATE DOMAIN address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN uint256 AS numeric(78, 0) CHECK (VALUE >= 0);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address address NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE agent_status AS ENUM ('draft', 'active', 'paused', 'retired');
CREATE TABLE agents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL,
  status     agent_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON agents (user_id);

CREATE TABLE tokens (
  address        address PRIMARY KEY,
  decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 77),
  symbol         text NOT NULL CHECK (char_length(symbol) <= 16),  -- sanitized, display only
  name           text NOT NULL CHECK (char_length(name) <= 64),    -- sanitized, display only
  is_stock_token boolean NOT NULL DEFAULT false,
  first_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- append-only: a new version is a new row, never an update
CREATE TABLE agent_configs (
  agent_id        uuid NOT NULL REFERENCES agents(id),
  version         integer NOT NULL CHECK (version > 0),
  system_prompt   text NOT NULL,
  model_provider  text NOT NULL,
  model_name      text NOT NULL,
  temperature     numeric(4, 3) NOT NULL,
  max_tokens      integer NOT NULL CHECK (max_tokens > 0),
  quote_asset     address NOT NULL REFERENCES tokens(address),
  context_inputs  jsonb NOT NULL DEFAULT '{}',
  cadence_seconds integer NOT NULL CHECK (cadence_seconds >= 60),
  triggers        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE risk_profiles (
  agent_id           uuid PRIMARY KEY REFERENCES agents(id),
  max_position_pct   numeric(6, 3),   -- NULL = unlimited
  max_exposure_pct   numeric(6, 3),
  max_daily_loss_pct numeric(6, 3),
  max_trades_per_day integer,
  max_slippage_bps   integer CHECK (max_slippage_bps IS NULL OR max_slippage_bps BETWEEN 0 AND 10000)
);

CREATE TYPE tp_sl_mode AS ENUM ('pct', 'price');
CREATE TABLE tp_sl_defaults (
  agent_id                  uuid PRIMARY KEY REFERENCES agents(id),
  sl_enabled                boolean NOT NULL DEFAULT false,
  sl_mode                   tp_sl_mode,
  sl_value                  numeric,
  tp_enabled                boolean NOT NULL DEFAULT false,
  tp_mode                   tp_sl_mode,
  tp_value                  numeric,
  deviation_timeout_seconds integer NOT NULL DEFAULT 300 CHECK (deviation_timeout_seconds >= 0)
);

CREATE TYPE wallet_custody AS ENUM ('derived', 'imported');
CREATE TABLE agent_wallets (
  agent_id         uuid PRIMARY KEY REFERENCES agents(id),
  address          address NOT NULL UNIQUE,
  derivation_index bigint NOT NULL UNIQUE CHECK (derivation_index >= 0),
  custody          wallet_custody NOT NULL DEFAULT 'derived',
  exported_at      timestamptz
);
CREATE SEQUENCE agent_derivation_index_seq MINVALUE 0 START 0;

CREATE TABLE agent_assets (
  agent_id      uuid NOT NULL REFERENCES agents(id),
  token_address address NOT NULL REFERENCES tokens(address),
  PRIMARY KEY (agent_id, token_address)
);

CREATE TABLE routes (
  token_address address NOT NULL REFERENCES tokens(address),
  quote_address address NOT NULL REFERENCES tokens(address),
  path          text NOT NULL,
  pools         address[] NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_address, quote_address)
);

CREATE TABLE market_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  ts            timestamptz NOT NULL,
  token_address address NOT NULL,
  pool          address NOT NULL,
  fee_tier      integer NOT NULL,
  price         numeric NOT NULL,
  oracle_price  numeric,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('market_snapshots', 'ts');
CREATE INDEX ON market_snapshots (token_address, ts DESC);

CREATE TYPE run_mode AS ENUM ('live', 'paper');
CREATE TYPE trade_action AS ENUM ('buy', 'sell', 'hold');
CREATE TABLE decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id),
  config_version integer,
  snapshot_id    bigint,
  mode           run_mode NOT NULL,
  origin         text NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'guard', 'user_close')),
  action         trade_action NOT NULL,
  token_address  address,
  size           jsonb,
  rationale      text,
  thesis         jsonb,
  confidence     numeric(4, 3),
  model          text,
  prompt_hash    text,
  response_hash  text,
  tokens_used    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, config_version) REFERENCES agent_configs(agent_id, version),
  -- LLM provenance is mandatory for agent decisions, absent for guard / user exits
  CHECK (origin <> 'agent' OR (config_version IS NOT NULL AND model IS NOT NULL
                               AND prompt_hash IS NOT NULL AND response_hash IS NOT NULL))
);
CREATE INDEX ON decisions (agent_id, created_at DESC);

CREATE TABLE rejections (
  decision_id uuid NOT NULL REFERENCES decisions(id),
  code        text NOT NULL,
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rejections (decision_id);

CREATE TYPE execution_kind AS ENUM ('approve', 'swap');
CREATE TABLE executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES decisions(id),
  kind        execution_kind NOT NULL,
  tx_hash     text NOT NULL UNIQUE,
  status      text NOT NULL CHECK (status IN ('signed', 'broadcast', 'confirmed', 'reverted', 'dropped', 'expired')),
  nonce       bigint NOT NULL,
  deadline    timestamptz,
  amount_in   uint256,
  amount_out  uint256,
  gas_used    uint256,
  block       bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id),
  token_address   address NOT NULL REFERENCES tokens(address),
  mode            run_mode NOT NULL,
  qty             uint256 NOT NULL,
  avg_entry_price numeric NOT NULL,
  UNIQUE (agent_id, token_address, mode)
);

CREATE TABLE backtests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id),
  config_version integer NOT NULL,
  from_ts        timestamptz NOT NULL,
  to_ts          timestamptz NOT NULL,
  status         text NOT NULL,
  result         jsonb,
  FOREIGN KEY (agent_id, config_version) REFERENCES agent_configs(agent_id, version)
);

CREATE TYPE guard_type AS ENUM ('stop_loss', 'take_profit');
CREATE TYPE guard_state AS ENUM ('armed', 'fired', 'cancelled');
CREATE TABLE guards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id         uuid NOT NULL REFERENCES positions(id),
  type                guard_type NOT NULL,
  mode                tp_sl_mode NOT NULL,
  value               numeric NOT NULL,
  trigger_price       numeric NOT NULL,
  set_by              text NOT NULL CHECK (set_by IN ('default', 'user_override')),
  state               guard_state NOT NULL DEFAULT 'armed',
  first_triggered_at  timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  last_rejection_code text,
  UNIQUE (position_id, type)
);

CREATE TABLE portfolio_snapshots (
  agent_id uuid NOT NULL,
  ts       timestamptz NOT NULL,
  nav_usdg numeric NOT NULL,
  PRIMARY KEY (agent_id, ts)
);
SELECT create_hypertable('portfolio_snapshots', 'ts');

CREATE TABLE llm_usage (
  user_id   uuid NOT NULL REFERENCES users(id),
  source    text NOT NULL CHECK (source IN ('agent', 'analyst', 'signal')),
  source_id uuid NOT NULL,
  day       date NOT NULL,
  tokens    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, source, source_id, day)
);

CREATE TABLE indexer_state (
  stream          text PRIMARY KEY,
  last_block      bigint NOT NULL,
  last_block_hash text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  block         bigint NOT NULL,
  block_time    timestamptz NOT NULL,
  tx_hash       text NOT NULL,
  log_index     integer NOT NULL,
  token_address address NOT NULL,
  "from"        address NOT NULL,
  "to"          address NOT NULL,
  amount        uint256 NOT NULL,
  PRIMARY KEY (block_time, tx_hash, log_index)
);
SELECT create_hypertable('transfers', 'block_time');
CREATE INDEX ON transfers ("from", block_time DESC);
CREATE INDEX ON transfers ("to", block_time DESC);
CREATE INDEX ON transfers (token_address, block_time DESC);

CREATE TABLE swaps (
  block      bigint NOT NULL,
  block_time timestamptz NOT NULL,
  tx_hash    text NOT NULL,
  log_index  integer NOT NULL,
  pool       address NOT NULL,
  sender     address NOT NULL,
  recipient  address NOT NULL,
  amount0    numeric(78, 0) NOT NULL,
  amount1    numeric(78, 0) NOT NULL,
  price      numeric NOT NULL,
  PRIMARY KEY (block_time, tx_hash, log_index)
);
SELECT create_hypertable('swaps', 'block_time');
CREATE INDEX ON swaps (pool, block_time DESC);

CREATE TABLE analyst_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  title      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analyst_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES analyst_conversations(id),
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content         text NOT NULL,
  model           text,
  tool_calls      jsonb,
  as_of_block     bigint,
  tokens_used     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rule_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  target           jsonb NOT NULL,   -- {kind: token|wallet, address}
  condition        text NOT NULL,
  params           jsonb NOT NULL,
  channels         text[] NOT NULL,
  cooldown_seconds integer NOT NULL DEFAULT 3600,
  enabled          boolean NOT NULL DEFAULT true
);

CREATE TABLE signal_profiles (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  version         integer NOT NULL,
  system_prompt   text NOT NULL,
  model_provider  text NOT NULL,
  model_name      text NOT NULL,
  tokens          address[] NOT NULL,
  cadence_seconds integer NOT NULL CHECK (cadence_seconds >= 60),
  channels        text[] NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id, version)
);

CREATE TABLE signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL,
  profile_version integer NOT NULL,
  snapshot_id     bigint,
  token_address   address NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  rationale       text NOT NULL,
  thesis          jsonb NOT NULL,
  confidence      numeric(4, 3) NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (profile_id, profile_version) REFERENCES signal_profiles(id, version)
);

CREATE TABLE alert_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL CHECK (source IN ('rule', 'signal', 'guard', 'system')),
  source_id          uuid NOT NULL,
  payload            jsonb NOT NULL,
  delivered_channels text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tracked_wallets (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  address address NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('siwe', 'agent', 'watch')),
  label   text,
  UNIQUE (user_id, address)
);

CREATE TABLE wallet_positions (
  address       address NOT NULL,
  token_address address NOT NULL,
  qty           uint256 NOT NULL,
  cost_basis    numeric,
  realized_pnl  numeric,
  as_of_block   bigint NOT NULL,
  PRIMARY KEY (address, token_address)
);
