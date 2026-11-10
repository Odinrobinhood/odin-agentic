-- Watchdog (architecture §8): de-duplicates alerts so a persisting condition is not re-sent every pass.
CREATE TABLE watchdog_state (
  key           text PRIMARY KEY,
  last_alert_at timestamptz NOT NULL,
  detail        jsonb
);
