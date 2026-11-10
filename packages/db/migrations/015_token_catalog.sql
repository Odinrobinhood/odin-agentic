-- Token catalog: every token with a Uniswap v3 pool on Robinhood Chain, discovered from the pinned
-- factory's PoolCreated events, so users can search and pick ANY token (not a curated list).

CREATE TABLE discovered_pools (
  pool          address PRIMARY KEY,
  token0        address NOT NULL,
  token1        address NOT NULL,
  fee           integer NOT NULL,
  created_block bigint NOT NULL
);
CREATE INDEX ON discovered_pools (token0);
CREATE INDEX ON discovered_pools (token1);

CREATE TABLE token_catalog (
  address        address PRIMARY KEY,
  symbol         text NOT NULL CHECK (char_length(symbol) <= 16),  -- sanitized, display only
  name           text NOT NULL CHECK (char_length(name) <= 64),    -- sanitized, display only
  decimals       smallint CHECK (decimals BETWEEN 0 AND 77),
  is_stock_token boolean NOT NULL DEFAULT false,
  -- a pool against USDG or WETH exists: the agent routing can reach it
  tradable       boolean NOT NULL DEFAULT false,
  -- USDG value of the base-asset side of its USDG/WETH pools: a depth hint for sorting
  depth_usdg     numeric,
  pools          integer NOT NULL DEFAULT 0,
  error          text,
  enriched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON token_catalog (upper(symbol));
CREATE INDEX ON token_catalog (depth_usdg DESC NULLS LAST);
