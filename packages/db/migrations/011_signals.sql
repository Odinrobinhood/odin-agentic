-- Signals & Alerts (architecture §3.14). Neither path can trade.

ALTER TABLE rule_alerts
  ADD COLUMN last_fired_at     timestamptz,
  ADD COLUMN last_evaluated_at timestamptz,
  -- event rules (transfers, wallet activity) resume from here so each event fires once
  ADD COLUMN cursor_block      bigint,
  ADD COLUMN created_at        timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON rule_alerts (user_id);

-- Scheduling state for AI signal profiles (latest version of each profile runs).
CREATE TABLE signal_schedule (
  profile_id   uuid PRIMARY KEY,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  lease_until  timestamptz,
  last_run_at  timestamptz,
  last_error   text
);
CREATE INDEX ON signals (profile_id, created_at DESC);
