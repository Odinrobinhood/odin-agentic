-- Backtesting (architecture §3.4): a config version replayed against market_snapshots by a separate worker.
ALTER TABLE backtests
  ADD COLUMN initial_capital numeric NOT NULL DEFAULT 1000 CHECK (initial_capital > 0),
  ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN started_at      timestamptz,
  ADD COLUMN finished_at     timestamptz,
  ADD COLUMN progress        integer NOT NULL DEFAULT 0,
  ADD COLUMN error           text;
ALTER TABLE backtests ADD CONSTRAINT backtests_status_check CHECK (status IN ('queued', 'running', 'done', 'failed'));
CREATE INDEX ON backtests (status) WHERE status = 'queued';
CREATE INDEX ON backtests (agent_id, created_at DESC);
