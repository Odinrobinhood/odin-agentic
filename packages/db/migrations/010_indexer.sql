-- Chain Indexer + Portfolio Tracker (architecture §3.12, §3.15).

-- One stream per indexed contract: 'transfer:<token>' or 'swap:<pool>'. last_block_hash detects reorgs.
ALTER TABLE indexer_state ADD COLUMN start_block bigint;
ALTER TABLE indexer_state ADD COLUMN contract address;

CREATE INDEX ON transfers (token_address, block);
CREATE INDEX ON swaps (pool, block);

-- Portfolio read model: one row per (wallet, token), recomputed from chain balances + indexed history.
ALTER TABLE wallet_positions
  ADD COLUMN value_usdg       numeric,
  ADD COLUMN unrealized_pnl   numeric,
  ADD COLUMN priced           boolean NOT NULL DEFAULT false,
  ADD COLUMN history_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now();
