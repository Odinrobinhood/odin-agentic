-- Executor (architecture §3.9): per-wallet nonce tracking and richer execution records.
ALTER TABLE executions
  ADD COLUMN wallet     address NOT NULL,
  ADD COLUMN channel    text NOT NULL DEFAULT 'agent' CHECK (channel IN ('agent', 'guard')),
  ADD COLUMN rpc        text,
  ADD COLUMN error_code text,
  ADD COLUMN error      text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON executions (wallet, nonce);
CREATE INDEX ON executions (status) WHERE status IN ('signed', 'broadcast');

-- Next nonce the executor will hand out per wallet. Reconciled against the chain on every reservation.
CREATE TABLE wallet_nonces (
  address    address PRIMARY KEY,
  next_nonce bigint NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
